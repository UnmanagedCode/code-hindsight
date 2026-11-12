// The only module that runs docker. It resolves how docker is invoked (directly, or through
// `sudo -n` when allowed), classifies failures into catalog errors, and refuses to touch any
// container, volume or network whose name lacks this plugin's prefix, or any image that is
// not pinned.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { writePrivateFileAtomic } from './fsPrivate.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE = 4 * 1024 * 1024;
const TAIL_BYTES = 8 * 1024;

/** Map docker's stderr to a catalog code. */
export function classifyDockerError(stderr) {
  const t = String(stderr ?? '');
  if (/permission denied/i.test(t) && /docker/i.test(t)) return 'DOCKER_DENIED';
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect/i.test(t)) return 'DOCKER_DAEMON_DOWN';
  if (/port is already allocated|address already in use/i.test(t)) return 'PORT_IN_USE';
  if (/No such image|Unable to find image/i.test(t)) return 'IMAGE_MISSING';
  return 'DOCKER_FAILED';
}

const tail = (s, n = TAIL_BYTES) => (s.length > n ? s.slice(-n) : s).trim();

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} [o.env] reads CODE_HINDSIGHT_DOCKER_BIN and CODE_HINDSIGHT_SUDO_BIN
 * @param {() => boolean} o.allowSudo read at every resolve, so a settings change applies on the next one
 * @param {string} o.prefix resource-name prefix every container, volume and network must carry
 * @param {string[]} o.images the image references this plugin may pull, save or remove
 * @param {string} o.runDir private directory for the short-lived env files `docker run` reads
 */
export function createDocker({ env = process.env, allowSudo, prefix, images, runDir }) {
  const dockerBin = env.CODE_HINDSIGHT_DOCKER_BIN || 'docker';
  const sudoBin = env.CODE_HINDSIGHT_SUDO_BIN || 'sudo';
  const pinned = new Set(images);
  let resolving = null;
  let info = { mode: null, serverVersion: null };

  function assertOwnedName(name) {
    if (typeof name !== 'string' || !(name === prefix || name.startsWith(`${prefix}-`))) {
      throw new Error(`refusing to touch "${name}": not a ${prefix}-* resource`);
    }
    return name;
  }
  function assertPinnedImage(ref) {
    if (!pinned.has(ref)) throw new Error(`refusing to touch image "${ref}": not pinned`);
    return ref;
  }

  /** Spawn one process; resolves {code, stdout, stderr} (code -1 + error for a spawn failure). */
  function raw(cmd, args, { stdin, stdout: sink, onLine, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env });
      } catch (error) {
        resolve({ code: -1, error, stdout: '', stderr: '' });
        return;
      }
      let out = '';
      let err = '';
      let lineBuf = '';
      let settled = false;
      const timer = timeoutMs ? setTimeout(() => { err += `\n(timed out after ${timeoutMs} ms)`; child.kill('SIGTERM'); }, timeoutMs) : null;
      const feedLines = (chunk) => {
        if (!onLine) return;
        lineBuf += chunk;
        const parts = lineBuf.split(/\r?\n|\r/);
        lineBuf = parts.pop();
        for (const l of parts) if (l) onLine(l);
      };
      if (sink) child.stdout.pipe(sink);
      else child.stdout.on('data', (c) => { const s = c.toString(); feedLines(s); if (out.length < MAX_CAPTURE) out += s; });
      child.stderr.on('data', (c) => { const s = c.toString(); feedLines(s); err = tail(err + s, 64 * 1024); });
      if (stdin) {
        child.stdin.on('error', () => {});
        stdin.on('error', (e) => { err += `\n(input failed: ${e.message})`; child.kill('SIGTERM'); });
        stdin.pipe(child.stdin);
      }
      const finish = (r) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (lineBuf && onLine) onLine(lineBuf);
        resolve(r);
      };
      child.on('error', (error) => finish({ code: -1, error, stdout: out, stderr: err }));
      child.on('close', (code, signal) => {
        if (!sink) return finish({ code: code ?? (signal ? 128 : -1), stdout: out, stderr: err });
        // Wait for the sink to flush what docker wrote before reporting success.
        if (sink.writableFinished) return finish({ code: code ?? -1, stdout: out, stderr: err });
        sink.once('finish', () => finish({ code: code ?? -1, stdout: out, stderr: err }));
        sink.once('error', (e) => finish({ code: -1, error: e, stdout: out, stderr: err }));
      });
    });
  }

  async function doResolve() {
    const probe = ['version', '--format', '{{.Server.Version}}'];
    const direct = await raw(dockerBin, probe, { timeoutMs: 20_000 });
    if (direct.code === 0) return { mode: 'docker', serverVersion: direct.stdout.trim() };
    if (direct.error?.code === 'ENOENT') throw new AppError('DOCKER_NOT_FOUND', { bin: dockerBin });
    const kind = classifyDockerError(direct.stderr);
    if (kind === 'DOCKER_DAEMON_DOWN') throw new AppError('DOCKER_DAEMON_DOWN', { detail: tail(direct.stderr, 400) });
    if (kind !== 'DOCKER_DENIED') throw new AppError('DOCKER_FAILED', { command: 'version', detail: tail(direct.stderr || direct.error?.message || '', 400) });
    if (!allowSudo()) throw new AppError('DOCKER_DENIED', { sudoAllowed: false, detail: tail(direct.stderr, 300) });
    const viaSudo = await raw(sudoBin, ['-n', dockerBin, ...probe], { timeoutMs: 20_000 });
    if (viaSudo.code === 0) return { mode: 'sudo', serverVersion: viaSudo.stdout.trim() };
    if (viaSudo.error?.code === 'ENOENT') throw new AppError('DOCKER_DENIED', { sudoAllowed: true, detail: `${sudoBin} is not installed` });
    if (classifyDockerError(viaSudo.stderr) === 'DOCKER_DAEMON_DOWN') throw new AppError('DOCKER_DAEMON_DOWN', { detail: tail(viaSudo.stderr, 400) });
    throw new AppError('DOCKER_DENIED', { sudoAllowed: true, detail: tail(viaSudo.stderr || `sudo exited ${viaSudo.code}`, 400) });
  }

  /** How docker is invoked; cached until `reset()` or a permission failure. */
  async function resolve() {
    if (!resolving) {
      resolving = doResolve().then(
        (r) => { info = r; return r; },
        (e) => { resolving = null; info = { mode: null, serverVersion: null }; throw e; },
      );
    }
    return resolving;
  }

  function reset() {
    resolving = null;
    info = { mode: null, serverVersion: null };
  }

  function argv(mode, args) {
    return mode === 'sudo' ? [sudoBin, ['-n', dockerBin, ...args]] : [dockerBin, args];
  }

  /** Run `docker <args>`; rejects with a catalog error on a non-zero exit unless `check: false`. */
  async function exec(args, opts = {}) {
    const { mode } = await resolve();
    const [cmd, full] = argv(mode, args);
    const r = await raw(cmd, full, opts);
    if (r.code !== 0 && opts.check !== false) {
      const code = r.error?.code === 'ENOENT' ? 'DOCKER_NOT_FOUND' : classifyDockerError(r.stderr);
      if (code === 'DOCKER_DENIED') reset();
      throw new AppError(code, { command: args.slice(0, 2).join(' '), detail: tail(r.stderr || r.error?.message || `exit ${r.code}`, 2000), bin: dockerBin });
    }
    return r;
  }

  async function inspect(kind, name) {
    const r = await exec([kind, 'inspect', name], { check: false, timeoutMs: 30_000 });
    if (r.code === 0) return JSON.parse(r.stdout)[0] ?? null;
    if (/No such|not found/i.test(r.stderr)) return null;
    const code = classifyDockerError(r.stderr);
    if (code === 'DOCKER_DENIED') reset();
    throw new AppError(code, { command: `${kind} inspect`, detail: tail(r.stderr, 1000) });
  }

  const labelArgs = (labels) => Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);

  return {
    resolve,
    reset,
    assertOwnedName,
    /** {mode: 'docker'|'sudo'|null, serverVersion} as last resolved. */
    info: () => ({ ...info }),
    exec,

    inspectImage: (ref) => inspect('image', ref),
    inspectContainer: (name) => inspect('container', assertOwnedName(name)),
    inspectNetwork: (name) => inspect('network', assertOwnedName(name)),
    inspectVolume: (name) => inspect('volume', assertOwnedName(name)),

    createNetwork: (name, labels) => exec(['network', 'create', ...labelArgs(labels), assertOwnedName(name)]),
    createVolume: (name, labels) => exec(['volume', 'create', ...labelArgs(labels), assertOwnedName(name)]),
    removeVolume: (name) => exec(['volume', 'rm', assertOwnedName(name)]),

    /**
     * `docker run` with a spec from containerSpec; the `--name` it carries must be ours. The
     * environment goes through a 0600 env file, so keys never appear on a command line.
     */
    async runContainer({ args, env: containerEnv }) {
      assertOwnedName(args[args.indexOf('--name') + 1]);
      const lines = Object.entries(containerEnv).map(([k, v]) => {
        if (/[\r\n]/.test(String(v))) throw new Error(`env ${k} contains a line break`);
        return `${k}=${v}`;
      });
      const envFile = path.join(runDir, `${crypto.randomBytes(8).toString('hex')}.env`);
      writePrivateFileAtomic(envFile, `${lines.join('\n')}\n`);
      try {
        return await exec(['run', '--env-file', envFile, ...args], { timeoutMs: 120_000 });
      } finally {
        fs.rmSync(envFile, { force: true });
      }
    },
    startContainer: (name) => exec(['start', assertOwnedName(name)], { timeoutMs: 120_000 }),
    stopContainers: (names, seconds = 30) => exec(['stop', '-t', String(seconds), ...names.map(assertOwnedName)], { timeoutMs: (seconds + 30) * 1000 }),
    removeContainer: (name) => exec(['rm', '-f', assertOwnedName(name)]),
    async logs(name, lines = 100) {
      const r = await exec(['logs', '--tail', String(lines), assertOwnedName(name)], { check: false, timeoutMs: 20_000 });
      return tail(`${r.stdout}\n${r.stderr}`, 64 * 1024);
    },

    /**
     * Stop containers in a process that outlives this one (own process group), so the
     * database shuts down cleanly after cc's grace period kills the backend. Returns the pid.
     */
    async stopDetached(names, seconds = 30) {
      names.forEach(assertOwnedName);
      const { mode } = await resolve();
      const [cmd, full] = argv(mode, ['stop', '-t', String(seconds), ...names]);
      const child = spawn(cmd, full, { detached: true, stdio: 'ignore', env });
      child.on('error', () => {});
      child.unref();
      return child.pid;
    },

    pull: (ref, onLine) => exec(['pull', assertPinnedImage(ref)], { onLine, timeoutMs: 60 * 60_000 }),
    /** `docker load` fed from `stdin` (an upload or a file this process opened). */
    load: (stdin, onLine) => exec(['load'], { stdin, onLine, timeoutMs: 60 * 60_000 }),
    /** `docker save` streamed into `sink` (written by this process, so a sudo docker never owns the file). */
    save: (refs, sink) => exec(['save', ...refs.map(assertPinnedImage)], { stdout: sink, timeoutMs: 60 * 60_000 }),
    removeImages: (refs) => exec(['rmi', ...refs.map(assertPinnedImage)]),
    /** Run the pinned build helper; `args` are `docker run` arguments after the helper's own name. */
    runHelper(name, runArgs, onLine) {
      assertOwnedName(name);
      return exec(['run', '--rm', '--name', name, ...runArgs], { onLine, timeoutMs: 2 * 60 * 60_000 });
    },
  };
}
