// User-initiated actions. Nothing here runs on its own: every network-touching or destructive
// operation is a job the user starts. One job at a time across every kind; each writes a log
// under the data dir and keeps a tail in memory for the UI. The Docker actions live here; other
// features register their own kinds (`kinds`), which report progress and can be cancelled.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  API_IMAGES, BASE_PATH, BUILD_HELPER, CP_DOCKERFILE, CP_IMAGE, CP_TARGET, HINDSIGHT_VERSION,
  LABELS, UPSTREAM_REPO, UPSTREAM_REVISION, VARIANTS,
} from './pins.js';
import { AppError, toAppError } from './errors.js';
import { ensurePrivateDir } from './fsPrivate.js';
import { isOurCpBuild } from './trust.js';
import { createTarAppender, createTarScanner } from './tarStream.js';

/** The Docker actions: they resolve docker first and re-read Hindsight's state after. */
export const JOB_KINDS = Object.freeze(['pull', 'build-cp', 'import', 'export', 'remove-images', 'delete-volume']);
/** Jobs that can fix a start precondition; only these may start Hindsight when they succeed. */
const PRECONDITION_JOBS = new Set(['pull', 'build-cp', 'import']);
/** The file inside an exported bundle that lists the image IDs it carries. */
export const BUNDLE_MANIFEST = 'code-hindsight-bundle.json';
const TAIL_LINES = 200;
const KEEP_JOBS = 20;

/** The command the build helper runs: buildx over the upstream source at the pinned commit. */
export function buildCpCommand() {
  return [
    'docker', 'buildx', 'build', '--progress', 'plain',
    `${UPSTREAM_REPO}#${UPSTREAM_REVISION}`,
    '-f', CP_DOCKERFILE,
    '--target', CP_TARGET,
    '--build-arg', `NEXT_PUBLIC_BASE_PATH=${BASE_PATH}`,
    '--label', `${LABELS.basePath}=${BASE_PATH}`,
    '--label', `${LABELS.upstream}=${UPSTREAM_REVISION}`,
    '-t', CP_IMAGE,
    '--load',
  ];
}

export const bundleName = (variant) => `code-hindsight-${HINDSIGHT_VERSION}-${variant}.tar`;
const BUNDLE_RE = /^code-hindsight-[0-9A-Za-z.-]+-(full|slim)\.tar$/;

/**
 * @param {object} o
 * @param {ReturnType<import('./docker.js').createDocker>} o.docker
 * @param {{afterPrecondition(): Promise<void>, refresh(): Promise<void>}} o.supervisor
 * @param {ReturnType<import('./containerSpec.js').resourceNames>} o.names
 * @param {string} o.owner
 * @param {string} o.dataDir
 * @param {Record<string, {validate(params: unknown): object, run(params: object, io: {line(l: string): void, progress(done: number, total: number, unit: string): void, signal: AbortSignal}): Promise<unknown>, cancellable: boolean}>} [o.kinds]
 *   registered kinds: `validate` throws a catalog error or returns the params `run` gets
 */
export function createJobs({ docker, supervisor, names, owner, dataDir, kinds = {}, now = () => Date.now() }) {
  const logDir = path.join(dataDir, 'logs', 'jobs');
  const bundleDir = path.join(dataDir, 'bundles');
  const jobs = new Map();
  let running = null;

  const view = (j) => ({
    id: j.id, kind: j.kind, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt, result: j.result, error: j.error,
    progress: j.progress, cancellable: j.cancellable, tail: j.tail.join('\n'),
  });

  async function assertStopped() {
    for (const n of [names.api, names.cp, names.relay]) {
      const c = await docker.inspectContainer(n);
      if (c && c.Config?.Labels?.[LABELS.owner] === owner && (c.State?.Running || c.State?.Restarting)) throw new AppError('CONTAINERS_RUNNING');
    }
  }

  /** Remove our stopped containers (they pin the volume and the images). */
  async function removeOurContainers() {
    for (const n of [names.relay, names.cp, names.api]) {
      const c = await docker.inspectContainer(n);
      if (c && c.Config?.Labels?.[LABELS.owner] === owner) await docker.removeContainer(n);
    }
  }

  const loadedFrom = (lines) => lines.map((l) => /^Loaded image(?: ID)?: (.+)$/.exec(l.trim())?.[1]).filter(Boolean);

  /** A loaded image's standing, for the import result: whether it will run. */
  function standing(ref, img) {
    const id = img?.Id ?? ref;
    if (VARIANTS.some((v) => API_IMAGES[v].ref === ref)) return { ref, id, status: 'pinned' };
    if (ref === CP_IMAGE) return { ref, id, status: isOurCpBuild(img) ? 'pinned' : 'wrong-build' };
    return { ref, id, status: 'unused' };
  }

  async function exportBundle(variant, line) {
    const want = API_IMAGES[variant];
    const api = await docker.inspectImage(want.ref);
    if (!api) throw new AppError('IMAGE_MISSING', { image: want.ref });
    const cp = await docker.inspectImage(CP_IMAGE);
    if (!cp) throw new AppError('CP_IMAGE_MISSING', { image: CP_IMAGE });
    ensurePrivateDir(bundleDir);
    const name = bundleName(variant);
    const final = path.join(bundleDir, name);
    const partial = `${final}.partial`;
    const manifest = { format: 1, hindsight: HINDSIGHT_VERSION, variant, images: [{ ref: want.ref, id: api.Id }, { ref: CP_IMAGE, id: cp.Id }], createdAt: new Date(now()).toISOString() };
    const appender = createTarAppender(BUNDLE_MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const hash = crypto.createHash('sha256');
    let size = 0;
    const hasher = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
    const written = pipeline(appender, hasher, fs.createWriteStream(partial, { mode: 0o600 }));
    line(`docker save ${want.ref} ${CP_IMAGE} → ${final}`);
    try {
      await docker.save([want.ref, CP_IMAGE], appender);
      await written;
    } catch (e) {
      appender.destroy();
      await written.catch(() => {});
      fs.rmSync(partial, { force: true });
      throw e;
    }
    fs.renameSync(partial, final);
    const sha256 = hash.digest('hex');
    line(`wrote ${size} bytes, sha256 ${sha256}`);
    return { name, path: final, size, sha256, images: manifest.images };
  }

  const handlers = {
    async pull({ variant }, line) {
      await docker.pull(API_IMAGES[variant].ref, line);
      const img = await docker.inspectImage(API_IMAGES[variant].ref);
      return { image: API_IMAGES[variant].ref, id: img?.Id ?? null };
    },
    async 'build-cp'(_p, line) {
      if (!(await docker.inspectImage(BUILD_HELPER))) {
        line(`docker pull ${BUILD_HELPER}`);
        await docker.pull(BUILD_HELPER, line);
      }
      await docker.runHelper(names.build, BUILD_HELPER, buildCpCommand(), line);
      const built = await docker.inspectImage(CP_IMAGE);
      if (!built) throw new AppError('CP_IMAGE_MISSING', { image: CP_IMAGE });
      return { image: CP_IMAGE, id: built.Id };
    },
    async import({ stdin, path: file }, line) {
      let input = stdin;
      if (!input) {
        input = fs.createReadStream(file);
        line(`docker load < ${file}`);
      }
      let manifest = null;
      const scanner = createTarScanner(BUNDLE_MANIFEST, (buf) => {
        try { manifest = JSON.parse(buf.toString('utf8')); } catch { manifest = null; }
      });
      input.on('error', (e) => scanner.destroy(e));
      input.pipe(scanner);
      const lines = [];
      await docker.load(scanner, (l) => { lines.push(l); line(l); });
      const loaded = [];
      for (const ref of loadedFrom(lines)) {
        const img = await docker.inspectImage(ref);
        loaded.push(standing(ref, img));
      }
      return { loaded, manifest };
    },
    export: ({ variant }, line) => exportBundle(variant, line),
    async 'remove-images'(_p, line) {
      await assertStopped();
      await removeOurContainers();
      const present = [];
      for (const ref of [...VARIANTS.map((v) => API_IMAGES[v].ref), CP_IMAGE]) if (await docker.inspectImage(ref)) present.push(ref);
      if (present.length) { line(`docker rmi ${present.join(' ')}`); await docker.removeImages(present); }
      return { removed: present };
    },
    async 'delete-volume'(_p, line) {
      await assertStopped();
      await removeOurContainers();
      const v = await docker.inspectVolume(names.volume);
      if (!v) return { removed: null };
      if (v.Labels?.[LABELS.owner] !== owner) throw new AppError('NAME_TAKEN', { kind: 'volume', name: names.volume });
      line(`docker volume rm ${names.volume}`);
      await docker.removeVolume(names.volume);
      return { removed: names.volume };
    },
  };

  /** Validate a job request; returns normalized params or throws a catalog error. */
  function validate(kind, params) {
    if (Object.hasOwn(kinds, kind)) return kinds[kind].validate(params ?? {});
    if (!JOB_KINDS.includes(kind)) throw new AppError('NOT_FOUND', { detail: `no job "${kind}"` });
    const p = params ?? {};
    if (kind === 'pull' || kind === 'export') {
      if (!VARIANTS.includes(p.variant)) throw new AppError('BAD_REQUEST', { detail: `variant must be one of ${VARIANTS.join(', ')}` });
      return { variant: p.variant };
    }
    if (kind === 'import') {
      if (p.stdin) return { stdin: p.stdin };
      if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw new AppError('IMPORT_PATH_INVALID', { path: String(p.path ?? ''), detail: 'must be an absolute path' });
      let st;
      try { st = fs.statSync(p.path); } catch (e) { throw new AppError('IMPORT_PATH_INVALID', { path: p.path, detail: e.code === 'ENOENT' ? 'no such file' : e.message }); }
      if (!st.isFile()) throw new AppError('IMPORT_PATH_INVALID', { path: p.path, detail: 'not a regular file' });
      try { fs.accessSync(p.path, fs.constants.R_OK); } catch { throw new AppError('IMPORT_PATH_INVALID', { path: p.path, detail: 'not readable' }); }
      return { path: p.path };
    }
    if (kind === 'remove-images') {
      if (p.confirm !== true) throw new AppError('CONFIRMATION_REQUIRED', { expected: 'confirm: true' });
      return {};
    }
    if (kind === 'delete-volume') {
      if (p.confirm !== names.volume) throw new AppError('CONFIRMATION_REQUIRED', { expected: names.volume });
      return {};
    }
    return {};
  }

  return {
    /**
     * Start a job. Resolves when it has started (the promise in `done` settles when it ends).
     * @returns {{job: object, done: Promise<object>}}
     */
    start(kind, params) {
      if (running) throw new AppError('BUSY', { job: running.kind });
      const p = validate(kind, params);
      const id = `${now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      ensurePrivateDir(logDir);
      const logFile = path.join(logDir, `${id}.log`);
      const fd = fs.openSync(logFile, 'a', 0o600);
      const registered = Object.hasOwn(kinds, kind) ? kinds[kind] : null;
      const controller = new AbortController();
      const job = {
        id, kind, state: 'running', startedAt: new Date(now()).toISOString(), endedAt: null, result: null, error: null, tail: [],
        progress: null, cancellable: !!registered?.cancellable, controller,
      };
      const line = (l) => {
        fs.writeSync(fd, `${l}\n`);
        job.tail.push(l);
        if (job.tail.length > TAIL_LINES) job.tail.splice(0, job.tail.length - TAIL_LINES);
      };
      const progress = (done, total, unit) => { job.progress = { done, total, unit }; };
      jobs.set(id, job);
      while (jobs.size > KEEP_JOBS) jobs.delete(jobs.keys().next().value);
      running = job;
      const done = (async () => {
        try {
          if (registered) {
            job.result = await registered.run(p, { line, progress, signal: controller.signal });
          } else {
            await docker.resolve();
            job.result = await handlers[kind](p, line);
          }
          job.state = 'done';
        } catch (e) {
          if (controller.signal.aborted) {
            job.state = 'cancelled';
            line('cancelled');
          } else {
            const err = toAppError(e, 'JOB_FAILED', { job: kind });
            job.error = err.toJSON();
            job.state = 'failed';
            line(`failed: ${err.message}`);
          }
        } finally {
          job.endedAt = new Date(now()).toISOString();
          job.controller = null;
          fs.closeSync(fd);
          running = null;
        }
        // Only a Docker job that can fix a start precondition may start Hindsight; the others re-read.
        if (!registered && job.state === 'done') await (PRECONDITION_JOBS.has(kind) ? supervisor.afterPrecondition() : supervisor.refresh()).catch(() => {});
        return view(job);
      })();
      return { job: view(job), done };
    },
    /**
     * Ask a running, cancellable job to stop; it ends `cancelled` at its next check.
     * @throws {AppError} NOT_FOUND, JOB_NOT_CANCELLABLE
     */
    cancel(id) {
      const job = jobs.get(id);
      if (!job) throw new AppError('NOT_FOUND', { detail: 'no such job' });
      if (job.state !== 'running' || !job.cancellable) throw new AppError('JOB_NOT_CANCELLABLE', { job: job.kind, ended: job.state !== 'running' });
      job.controller.abort();
      return view(job);
    },
    get: (id) => (jobs.has(id) ? view(jobs.get(id)) : null),
    list: () => [...jobs.values()].reverse().map((j) => ({ ...view(j), tail: undefined })),
    current: () => (running ? view(running) : null),
    /** A bundle file's path when `name` is one this plugin wrote, else null. */
    bundlePath(name) {
      if (typeof name !== 'string' || !BUNDLE_RE.test(name)) return null;
      let listing;
      try { listing = fs.readdirSync(bundleDir); } catch { return null; }
      return listing.includes(name) ? path.join(bundleDir, name) : null;
    },
    bundles() {
      let listing;
      try { listing = fs.readdirSync(bundleDir); } catch { return []; }
      return listing.filter((n) => BUNDLE_RE.test(n)).map((n) => ({ name: n, size: fs.statSync(path.join(bundleDir, n)).size }));
    },
  };
}
