// jobs.js over the fake docker: each explicit action's docker arguments, one job at a time,
// streamed import, bundle export, and the confirmations destructive actions need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createDocker } from '../src/docker.js';
import { createJobs, buildCpCommand, buildGpuCommand, bundleName, BUNDLE_MANIFEST } from '../src/jobs.js';
import { createTarScanner } from '../src/tarStream.js';
import { AppError } from '../src/errors.js';
import { resourceNames, ownerId } from '../src/containerSpec.js';
import { API_IMAGES, API_GPU_IMAGE, BUILD_HELPER, CP_IMAGE, LABELS, BASE_PATH, GPU_DOCKERFILE, GPU_TORCH_FLAVOR, GPU_TORCH_INDEX, HINDSIGHT_VERSION, UPSTREAM_REVISION } from '../src/pins.js';
import { mkRoot, fakeEnv, seedDocker, dockerCalls, dockerState, goodApiImage, goodCpImage, goodGpuImage, helperImage, CP_ID, API_ID, GPU_ID, fakeBundle } from './helpers.mjs';

const names = resourceNames('code-hindsight');

function make(t, { seed, mode } = {}) {
  const r = mkRoot(t);
  seedDocker(r, seed);
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  const docker = createDocker({ env: fakeEnv(r, { mode }), allowSudo: () => true, prefix: 'code-hindsight', images: [API_IMAGES.full.ref, API_IMAGES.slim.ref, API_GPU_IMAGE, CP_IMAGE, BUILD_HELPER], runDir: r.dataDir });
  const after = [];
  const refreshed = [];
  const supervisor = { afterPrecondition: async () => { after.push(1); }, refresh: async () => { refreshed.push(1); } };
  const owner = ownerId(r.dataDir);
  const jobs = createJobs({ docker, supervisor, names, owner, dataDir: r.dataDir });
  return { r, docker, jobs, after, refreshed, owner };
}
const ourContainer = (owner, running) => ({ Name: '/x', Image: 'i', Config: { Labels: { [LABELS.owner]: owner } }, State: { Status: running ? 'running' : 'exited', Running: running } });

// Spec 3: pull is an explicit job; it runs `docker pull` of the pinned ref only, then re-checks.
test('pull pulls the pinned image of the variant and re-checks the preconditions', async (t) => {
  const { r, jobs, after } = make(t, { seed: { images: {} } });
  const { job, done } = jobs.start('pull', { variant: 'slim' });
  assert.equal(job.state, 'running');
  const end = await done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'pull'), ['pull', API_IMAGES.slim.ref]);
  assert.ok(dockerState(r).images[API_IMAGES.slim.ref]);
  assert.match(end.tail, /Downloaded/);
  assert.equal(after.length, 1);
  assert.match(fs.readFileSync(path.join(r.dataDir, 'logs', 'jobs', `${job.id}.log`), 'utf8'), /Pulling/);
});

// Spec 6 + S8: the CP image is built from the pinned upstream commit with our base path.
// S1: the helper gets the Docker socket only as the pinned tag, run by that tag.
test('build-cp runs buildx at the pinned commit in the helper, by its pinned tag', async (t) => {
  const { r, jobs, after } = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage(), [BUILD_HELPER]: helperImage() }, registry: { [CP_IMAGE]: goodCpImage() } } });
  const end = await jobs.start('build-cp').done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  const run = dockerCalls(r).find((a) => a[0] === 'run');
  assert.deepEqual(run.slice(0, 7), ['run', '--rm', '--name', 'code-hindsight-build', '-v', '/var/run/docker.sock:/var/run/docker.sock', BUILD_HELPER]);
  assert.deepEqual(run.slice(7), buildCpCommand());
  const cmd = buildCpCommand();
  assert.ok(cmd.includes(`https://github.com/vectorize-io/hindsight.git#${UPSTREAM_REVISION}`));
  assert.equal(cmd[cmd.indexOf('--target') + 1], 'cp-only');
  assert.equal(cmd[cmd.indexOf('-f') + 1], 'docker/standalone/Dockerfile');
  assert.equal(cmd[cmd.indexOf('--build-arg') + 1], `NEXT_PUBLIC_BASE_PATH=${BASE_PATH}`);
  assert.ok(cmd.includes(`${LABELS.basePath}=${BASE_PATH}`) && cmd.includes(`${LABELS.upstream}=${UPSTREAM_REVISION}`));
  assert.equal(cmd[cmd.indexOf('-t') + 1], CP_IMAGE);
  assert.equal(end.result.id, CP_ID);
  assert.equal(after.length, 1, 'a precondition job re-checks the start');
});

// Directive: images are pinned by tag, never by digest.
test('build-cp pulls a missing helper by its pinned tag', async (t) => {
  const { r, jobs } = make(t, { seed: { images: {}, registry: { [BUILD_HELPER]: helperImage(), [CP_IMAGE]: goodCpImage() } } });
  const end = await jobs.start('build-cp').done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'pull'), ['pull', BUILD_HELPER]);
  assert.doesNotMatch(BUILD_HELPER, /@sha256:/);
});

// S1: the Docker socket goes only to the pinned helper tag, whatever the image's ID.
test('only the pinned helper tag gets the Docker socket', async (t) => {
  const { r, jobs, docker } = make(t, { seed: { images: { [BUILD_HELPER]: helperImage() }, registry: { [CP_IMAGE]: goodCpImage() } } });
  const end = await jobs.start('build-cp').done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  assert.ok(dockerCalls(r).some((a) => a[0] === 'run'));
  await docker.resolve();
  assert.throws(() => docker.runHelper('code-hindsight-build', 'docker:latest', ['true']), /refusing to give the Docker socket/);
  assert.throws(() => docker.runHelper('code-hindsight-build', `sha256:${'e'.repeat(64)}`, ['true']), /refusing to give the Docker socket/);
});

// GPU2: the GPU image is upstream's CUDA recipe at the pinned commit, FROM the pinned full image,
// built in the pinned helper, labelled so the start can tell it is ours.
test('GPU2: build-gpu runs the pinned upstream CUDA recipe in the helper with the pinned version, torch flavour, labels and tag', async (t) => {
  const { r, jobs, after } = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage(), [BUILD_HELPER]: helperImage() }, registry: { [API_GPU_IMAGE]: goodGpuImage() } } });
  const end = await jobs.start('build-gpu').done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  const run = dockerCalls(r).find((a) => a[0] === 'run');
  assert.deepEqual(run.slice(0, 7), ['run', '--rm', '--name', 'code-hindsight-build', '-v', '/var/run/docker.sock:/var/run/docker.sock', BUILD_HELPER]);
  assert.deepEqual(run.slice(7), buildGpuCommand());
  const cmd = buildGpuCommand();
  assert.deepEqual(cmd.slice(0, 3), ['docker', 'buildx', 'build']);
  assert.ok(cmd.includes(`https://github.com/vectorize-io/hindsight.git#${UPSTREAM_REVISION}`));
  assert.equal(cmd[cmd.indexOf('-f') + 1], GPU_DOCKERFILE);
  const buildArgs = cmd.flatMap((a, i) => (cmd[i - 1] === '--build-arg' ? [a] : []));
  assert.deepEqual(buildArgs, [`HINDSIGHT_VERSION=${HINDSIGHT_VERSION}`, `PYTORCH_CUDA_FLAVOR=${GPU_TORCH_FLAVOR}`, `PYTORCH_CUDA_INDEX=${GPU_TORCH_INDEX}`]);
  assert.equal(`ghcr.io/vectorize-io/hindsight:${HINDSIGHT_VERSION}`, API_IMAGES.full.ref, 'the recipe builds FROM the pinned full image');
  assert.ok(cmd.includes(`${LABELS.upstream}=${UPSTREAM_REVISION}`) && cmd.includes(`${LABELS.cuda}=${GPU_TORCH_FLAVOR}`));
  assert.equal(cmd[cmd.indexOf('-t') + 1], API_GPU_IMAGE);
  assert.equal(cmd.at(-1), '--load');
  assert.deepEqual(end.result, { image: API_GPU_IMAGE, id: GPU_ID });
  assert.equal(after.length, 1, 'a precondition job: a GPU start waiting on the image starts');
});

test('GPU2: build-gpu without the full image is IMAGE_MISSING and runs nothing', async (t) => {
  const { r, jobs, after } = make(t, { seed: { images: { [BUILD_HELPER]: helperImage() } } });
  const end = await jobs.start('build-gpu').done;
  assert.equal(end.state, 'failed');
  assert.equal(end.error.code, 'IMAGE_MISSING');
  assert.equal(end.error.params.image, API_IMAGES.full.ref);
  assert.equal(dockerCalls(r).some((a) => a[0] === 'run' || a[0] === 'pull'), false, 'no helper run, nothing pulled');
  assert.equal(after.length, 0);
});

test('GPU2: build-gpu pulls only a missing helper, and a result without the GPU labels is GPU_IMAGE_MISSING', async (t) => {
  const { r, jobs } = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage() }, registry: { [BUILD_HELPER]: helperImage(), [API_GPU_IMAGE]: { Id: GPU_ID, Config: { Labels: {} } } } } });
  const end = await jobs.start('build-gpu').done;
  assert.deepEqual(dockerCalls(r).filter((a) => a[0] === 'pull'), [['pull', BUILD_HELPER]]);
  assert.deepEqual(dockerCalls(r).filter((a) => a[0] === 'run').map((a) => a[6]), [BUILD_HELPER], 'only the helper runs');
  assert.equal(end.state, 'failed');
  assert.equal(end.error.code, 'GPU_IMAGE_MISSING');
});

// Decision 14: one job at a time.
test('a second job while one runs is refused BUSY', async (t) => {
  const { jobs } = make(t);
  const first = jobs.start('pull', { variant: 'full' });
  assert.throws(() => jobs.start('pull', { variant: 'slim' }), (e) => e.code === 'BUSY' && e.params.job === 'pull');
  await first.done;
  assert.equal((await jobs.start('pull', { variant: 'slim' }).done).state, 'done');
});

test('a failed job reports its error and frees the runner', async (t) => {
  const { jobs, after } = make(t, { seed: { registry: {} } });
  const end = await jobs.start('pull', { variant: 'full' }).done;
  assert.equal(end.state, 'failed');
  assert.match(end.error.message, /pull access denied/);
  assert.equal(after.length, 0);
  assert.equal(jobs.current(), null);
});

// Spec 3: import from an upload streams the body into `docker load`.
test('import streams an upload into docker load and reports the loaded tags', async (t) => {
  const { jobs, r } = make(t, { seed: { images: {} } });
  const bundle = { [API_IMAGES.full.ref]: goodApiImage(), [CP_IMAGE]: goodCpImage() };
  const end = await jobs.start('import', { stdin: Readable.from(chunks(fakeBundle(bundle), 700)) }).done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  // Each loaded image with its ID and standing: the API image and the CP image built for this plugin are pinned.
  assert.deepEqual(end.result.loaded, [
    { ref: API_IMAGES.full.ref, id: API_ID, status: 'pinned' },
    { ref: CP_IMAGE, id: CP_ID, status: 'pinned' },
  ]);
  assert.equal(end.result.manifest, null, 'a plain docker save has no bundle manifest');
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'load'), ['load']);
});

test('import from a host path validates the path, then loads the file', async (t) => {
  const { jobs, r } = make(t, { seed: { images: {} } });
  assert.throws(() => jobs.start('import', { path: 'relative.tar' }), { code: 'IMPORT_PATH_INVALID' });
  assert.throws(() => jobs.start('import', { path: path.join(r.root, 'missing.tar') }), (e) => e.code === 'IMPORT_PATH_INVALID' && /no such file/.test(e.message));
  assert.throws(() => jobs.start('import', { path: r.root }), (e) => /not a regular file/.test(e.message));
  const file = path.join(r.root, 'bundle.tar');
  fs.writeFileSync(file, fakeBundle({ [API_IMAGES.slim.ref]: { ...goodApiImage('slim'), Id: `sha256:${'9'.repeat(64)}` } }));
  const end = await jobs.start('import', { path: file }).done;
  // Directive: no ID check; an API image under the pinned tag is pinned whatever its ID.
  assert.deepEqual(end.result.loaded, [{ ref: API_IMAGES.slim.ref, id: `sha256:${'9'.repeat(64)}`, status: 'pinned' }]);
  // S2: a CP image under its tag without this plugin's build labels is flagged.
  const other = path.join(r.root, 'other.tar');
  fs.writeFileSync(other, fakeBundle({ [CP_IMAGE]: { Id: CP_ID, Config: { Labels: { [LABELS.basePath]: '/other', [LABELS.upstream]: UPSTREAM_REVISION } } } }));
  const wrong = await jobs.start('import', { path: other }).done;
  assert.deepEqual(wrong.result.loaded, [{ ref: CP_IMAGE, id: CP_ID, status: 'wrong-build' }]);
});

// Spec 3: export writes a bundle of the API image and the CP image, with size and sha256.
test('export saves the variant\'s API image and the CP image to a 0600 bundle with its sha256', async (t) => {
  const { jobs, r } = make(t);
  const end = await jobs.start('export', { variant: 'full' }).done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'save'), ['save', API_IMAGES.full.ref, CP_IMAGE]);
  const file = end.result.path;
  assert.equal(path.basename(file), bundleName('full'));
  const bytes = fs.readFileSync(file);
  assert.equal(end.result.size, bytes.length);
  assert.equal(end.result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(jobs.bundlePath(bundleName('full')), file);
  assert.equal(jobs.bundlePath('../secrets.json'), null);
  assert.equal(jobs.bundlePath(bundleName('slim')), null, 'only bundles that exist');
  assert.deepEqual(jobs.bundles().map((b) => b.name), [bundleName('full')]);
  // The bundle carries a manifest of the image IDs inside it, and stays loadable.
  let manifest = null;
  await new Promise((res, rej) => Readable.from([bytes]).pipe(createTarScanner(BUNDLE_MANIFEST, (b) => { manifest = JSON.parse(b); })).on('finish', res).on('error', rej).resume());
  assert.deepEqual(manifest.images, [{ ref: API_IMAGES.full.ref, id: API_ID }, { ref: CP_IMAGE, id: CP_ID }]);
  assert.deepEqual(end.result.images, manifest.images);
  const reimport = await jobs.start('import', { path: file }).done;
  assert.equal(reimport.state, 'done', JSON.stringify(reimport.error));
  assert.deepEqual(reimport.result.manifest.images, manifest.images, 'the import reads the manifest back');
});

test('export of a missing image is refused before anything is written', async (t) => {
  const { jobs, r } = make(t, { seed: { images: { [CP_IMAGE]: goodCpImage() } } });
  const end = await jobs.start('export', { variant: 'slim' }).done;
  assert.equal(end.error.code, 'IMAGE_MISSING');
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'save'));
  assert.equal(fs.existsSync(path.join(r.dataDir, 'bundles', bundleName('slim'))), false);
});

// Spec 4: the volume is deleted only on a confirmed action, with the containers stopped.
test('delete-volume needs the typed volume name and stopped containers', async (t) => {
  const { jobs, r, owner } = make(t);
  assert.throws(() => jobs.start('delete-volume', {}), (e) => e.code === 'CONFIRMATION_REQUIRED' && e.params.expected === names.volume);
  assert.throws(() => jobs.start('delete-volume', { confirm: 'yes' }), { code: 'CONFIRMATION_REQUIRED' });
  seedDocker(r, { containers: { [names.api]: ourContainer(owner, true) }, volumes: { [names.volume]: { Name: names.volume, Labels: { [LABELS.owner]: owner } } } });
  const refused = await jobs.start('delete-volume', { confirm: names.volume }).done;
  assert.equal(refused.error.code, 'CONTAINERS_RUNNING');
  assert.ok(dockerState(r).volumes[names.volume]);
  seedDocker(r, { containers: { [names.api]: ourContainer(owner, false) }, volumes: { [names.volume]: { Name: names.volume, Labels: { [LABELS.owner]: owner } } } });
  const end = await jobs.start('delete-volume', { confirm: names.volume }).done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  assert.equal(dockerState(r).volumes[names.volume], undefined);
});

test('remove-images needs confirmation and stopped containers, and removes only pinned tags', async (t) => {
  const { jobs, r, owner } = make(t);
  assert.throws(() => jobs.start('remove-images', {}), { code: 'CONFIRMATION_REQUIRED' });
  seedDocker(r, { containers: { [names.cp]: ourContainer(owner, true) } });
  assert.equal((await jobs.start('remove-images', { confirm: true }).done).error.code, 'CONTAINERS_RUNNING');
  seedDocker(r);
  setStateExtra(r);
  const end = await jobs.start('remove-images', { confirm: true }).done;
  assert.deepEqual(end.result.removed, [API_IMAGES.full.ref, API_IMAGES.slim.ref, CP_IMAGE]);
  assert.equal(dockerCalls(r).some((a) => a[0] === 'rmi' && a.includes(API_GPU_IMAGE)), false, 'an absent GPU image is not named');
  assert.deepEqual(Object.keys(dockerState(r).images).sort(), [BUILD_HELPER, 'node:24'].sort(), 'the build helper and unpinned images stay');
});

// GPU9: the GPU image is one of the plugin's images: Remove images removes it.
test('GPU9: remove-images removes the GPU image when present', async (t) => {
  const { jobs, r } = make(t);
  const s = dockerState(r);
  s.images[API_GPU_IMAGE] = goodGpuImage();
  fs.writeFileSync(r.statePath, JSON.stringify(s));
  const end = await jobs.start('remove-images', { confirm: true }).done;
  assert.ok(end.result.removed.includes(API_GPU_IMAGE));
  assert.equal(dockerState(r).images[API_GPU_IMAGE], undefined);
});

function setStateExtra(r) {
  const s = dockerState(r);
  s.images['node:24'] = { Id: 'n' };
  fs.writeFileSync(r.statePath, JSON.stringify(s));
}

test('unknown kinds and bad variants are refused', (t) => {
  const { jobs } = make(t);
  assert.throws(() => jobs.start('format-disk'), { code: 'NOT_FOUND' });
  assert.throws(() => jobs.start('pull', { variant: 'mega' }), { code: 'BAD_REQUEST' });
});

// C5: only jobs that fix a start precondition may start Hindsight; the others only re-read.
test('export, delete-volume and remove-images never trigger a start', async (t) => {
  const { jobs, after, refreshed } = make(t);
  await jobs.start('export', { variant: 'full' }).done;
  await jobs.start('delete-volume', { confirm: names.volume }).done;
  await jobs.start('remove-images', { confirm: true }).done;
  assert.equal(after.length, 0);
  assert.equal(refreshed.length, 3);
});

const chunks = (buf, n) => { const out = []; for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n)); return out; };

// Registered (non-Docker) kinds: the backfill jobs run through this same runner.
function makeRegistered(t, kinds) {
  const r = mkRoot(t);
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  const resolves = [];
  const hooks = [];
  const docker = { resolve: async () => { resolves.push(1); }, pull: async () => {}, inspectImage: async () => null };
  const supervisor = { afterPrecondition: async () => { hooks.push('after'); }, refresh: async () => { hooks.push('refresh'); } };
  const jobs = createJobs({ docker, supervisor, names, owner: ownerId(r.dataDir), dataDir: r.dataDir, kinds });
  return { jobs, resolves, hooks };
}
const gate = () => { let open; const p = new Promise((res) => { open = res; }); return { p, open }; };

// A6 / invariant: a registered kind reports progress and never touches Docker or Hindsight's lifecycle.
test('a registered kind reports progress, skips docker.resolve and the supervisor hook', async (t) => {
  const g = gate();
  const seen = [];
  const { jobs, resolves, hooks } = makeRegistered(t, {
    work: {
      cancellable: true,
      validate: (p) => { if (p.n === undefined) throw new AppError('BAD_REQUEST', { detail: 'n' }); return { n: p.n }; },
      async run({ n }, { line, progress }) { progress(1, n, 'files'); line('one'); await g.p; progress(n, n, 'files'); return { n }; },
    },
  });
  assert.throws(() => jobs.start('work', {}), { code: 'BAD_REQUEST' });
  const { job, done } = jobs.start('work', { n: 3 });
  assert.equal(job.cancellable, true);
  await new Promise((res) => setImmediate(res));
  seen.push(jobs.get(job.id).progress);
  g.open();
  const end = await done;
  assert.deepEqual(seen, [{ done: 1, total: 3, unit: 'files' }]);
  assert.deepEqual([end.state, end.result, end.progress], ['done', { n: 3 }, { done: 3, total: 3, unit: 'files' }]);
  assert.match(end.tail, /one/);
  assert.deepEqual([resolves.length, hooks.length], [0, 0]);
});

// A6 / invariant: only a running, cancellable job can be cancelled; it ends `cancelled`, not failed.
test('cancel aborts a running cancellable job → state cancelled; a docker job or an ended job is refused JOB_NOT_CANCELLABLE', async (t) => {
  const g = gate();
  const { jobs } = makeRegistered(t, {
    slow: {
      cancellable: true,
      validate: () => ({}),
      async run(_p, { signal }) { await new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); },
    },
  });
  assert.throws(() => jobs.cancel('nope'), { code: 'NOT_FOUND' });
  const { job, done } = jobs.start('slow', {});
  const view = jobs.cancel(job.id);
  assert.equal(view.id, job.id);
  const end = await done;
  assert.deepEqual([end.state, end.error], ['cancelled', null]);
  assert.match(end.tail, /cancelled/);
  assert.throws(() => jobs.cancel(job.id), (e) => e.code === 'JOB_NOT_CANCELLABLE' && e.params.ended === true);
  const docker = jobs.start('pull', { variant: 'full' });
  assert.equal(docker.job.cancellable, false);
  assert.throws(() => jobs.cancel(docker.job.id), (e) => e.code === 'JOB_NOT_CANCELLABLE' && e.params.ended === false);
  await docker.done;
  g.open();
});

// A6 / invariant: one job at a time across every kind.
test('a backfill job and a docker job cannot run together (BUSY)', async (t) => {
  const g = gate();
  const { jobs } = makeRegistered(t, { 'backfill-scan': { cancellable: true, validate: () => ({}), run: () => g.p } });
  const scan = jobs.start('backfill-scan', {});
  assert.throws(() => jobs.start('pull', { variant: 'full' }), (e) => e.code === 'BUSY' && e.params.job === 'backfill-scan');
  g.open();
  await scan.done;
  const pull = jobs.start('pull', { variant: 'full' });
  assert.throws(() => jobs.start('backfill-scan', {}), (e) => e.code === 'BUSY' && e.params.job === 'pull');
  await pull.done;
});
