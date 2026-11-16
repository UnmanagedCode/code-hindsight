// Shared test fixtures: a temp projects root and data dir per test, the fake docker/sudo
// environment, seeded fake-docker state, and a fake clock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_IMAGES, BASE_PATH, BUILD_HELPER, CP_IMAGE, GPU_TORCH_FLAVOR, LABELS, UPSTREAM_REVISION } from '../src/pins.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_DOCKER = path.join(here, 'fakes', 'fake-docker.mjs');
export const FAKE_SUDO = path.join(here, 'fakes', 'fake-sudo.mjs');
export const REPO = path.dirname(here);

/**
 * A fresh temp PROJECTS_ROOT with the plugin data dir inside it (never the real one), plus
 * the fake docker's state and call-log files.
 */
export function mkRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-hindsight-test-'));
  const projectsRoot = path.join(root, 'projects');
  const dataDir = path.join(projectsRoot, '.code-conductor', 'plugins', 'data', 'code-hindsight');
  fs.mkdirSync(projectsRoot, { recursive: true });
  const statePath = path.join(root, 'docker-state.json');
  const logPath = path.join(root, 'docker-calls.jsonl');
  fs.writeFileSync(logPath, '');
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, projectsRoot, dataDir, statePath, logPath };
}

/** The env that points docker.js at the fakes. */
export function fakeEnv(r, { mode = '', sudoMode = 'ok' } = {}) {
  return {
    ...process.env,
    PROJECTS_ROOT: r.projectsRoot,
    CONDUCTOR_PLUGIN_DATA_DIR: r.dataDir,
    CODE_HINDSIGHT_DOCKER_BIN: FAKE_DOCKER,
    CODE_HINDSIGHT_SUDO_BIN: FAKE_SUDO,
    FAKE_DOCKER_STATE: r.statePath,
    FAKE_DOCKER_LOG: r.logPath,
    FAKE_DOCKER_MODE: mode,
    FAKE_SUDO_MODE: sudoMode,
  };
}

export const API_ID = `sha256:${'a'.repeat(64)}`;
export const goodApiImage = (variant = 'full') => ({
  Id: API_ID,
  Config: { Labels: { 'org.opencontainers.image.version': variant === 'slim' ? '1.2.1-slim' : '1.2.1', 'org.opencontainers.image.revision': UPSTREAM_REVISION } },
});
export const CP_ID = `sha256:${'c'.repeat(64)}`;
export const goodCpImage = (id = CP_ID) => ({ Id: id, Config: { Labels: { [LABELS.basePath]: BASE_PATH, [LABELS.upstream]: UPSTREAM_REVISION } } });
export const GPU_ID = `sha256:${'d'.repeat(64)}`;
/** The GPU image as build-gpu labels it (seed it under API_GPU_IMAGE). */
export const goodGpuImage = (id = GPU_ID) => ({ Id: id, Config: { Labels: { [LABELS.upstream]: UPSTREAM_REVISION, [LABELS.cuda]: GPU_TORCH_FLAVOR } } });
export const helperImage = () => ({ Id: `sha256:${'e'.repeat(64)}`, Config: { Labels: {} } });

/** Seed the fake daemon: by default both API images and the CP image are present and pullable. */
export function seedDocker(r, { images, registry, containers = {}, networks = {}, volumes = {} } = {}) {
  const all = { [API_IMAGES.full.ref]: goodApiImage('full'), [API_IMAGES.slim.ref]: goodApiImage('slim'), [CP_IMAGE]: goodCpImage(), [BUILD_HELPER]: helperImage() };
  fs.writeFileSync(r.statePath, JSON.stringify({ images: images ?? all, registry: registry ?? all, containers, networks, volumes }));
}

export const dockerState = (r) => JSON.parse(fs.readFileSync(r.statePath, 'utf8'));
export function setDockerState(r, mutate) {
  const s = dockerState(r);
  mutate(s);
  fs.writeFileSync(r.statePath, JSON.stringify(s));
}

/** Every docker invocation the fake saw, as argument arrays. */
export function dockerCalls(r) {
  return fs.readFileSync(r.logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.args).map((e) => e.args);
}

/** A clock whose sleep advances time at once. */
export function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); }, advance: (ms) => { t += ms; } };
}

/** Write settings.json into the data dir before the app starts. */
export function writeSettings(r, settings) {
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(r.dataDir, 'settings.json'), JSON.stringify(settings));
}

export async function waitFor(fn, { timeoutMs = 5_000, stepMs = 10 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((res) => setTimeout(res, stepMs));
  }
}

/**
 * Boot the app (createApp) on 127.0.0.1:0 over the fakes and a temp data dir. Resolves
 * {url, app, r}. `cc` is an optional fake cc base URL; `claudeProjectsDir` a temp transcripts
 * root (default: an empty temp path); `ollamaUrl` the Ollama daemon (default: nothing listens); `cpSession` replaces the control-plane sign-in (needed to reach `ready` with no CP); `relay` replaces the relay tunnel; `hindsight` replaces the supervisor's connection to
 * Hindsight (`() => ({apiUrl, apiKey}) | null`, for a fake Hindsight).
 */
export async function boot(t, { mode = '', sudoMode, seed, settings, distDir, cc = null, probe = async () => 0, start = true, claudeProjectsDir, hindsight, ollamaUrl = 'http://127.0.0.1:1', cpSession, relay } = {}) {
  const http = await import('node:http');
  const { createApp } = await import('../src/app.js');
  const r = mkRoot(t);
  seedDocker(r, seed);
  if (settings) writeSettings(r, settings);
  // Never the real transcripts: a temp dir unless the test writes its own.
  const config = { port: 0, dataDir: r.dataDir, conductorUrl: cc, ollamaUrl, pluginId: 'code-hindsight', distDir: distDir ?? path.join(r.root, 'no-dist'), claudeProjectsDir: claudeProjectsDir ?? path.join(r.root, 'claude-config', 'projects') };
  const app = createApp(config, { env: fakeEnv(r, { mode, sudoMode }), detectBind: () => '127.0.0.1', supervisorOptions: { probe, clock: fakeClock(), watch: false, log: () => {}, ...(cpSession ? { cpSession } : {}), ...(relay ? { relay } : {}) }, hindsightConnection: hindsight });
  const server = http.createServer(app.handle);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.closeAllConnections(); server.close(); });
  if (start) await app.supervisor.ensureRunning();
  return { url: `http://127.0.0.1:${server.address().port}`, app, r };
}

/** A bundle as the fake docker reads it: a tar holding fake-images.json. */
export function fakeBundle(images) {
  const data = Buffer.from(JSON.stringify({ images }));
  const h = Buffer.alloc(512);
  h.write('fake-images.json', 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]);
}
