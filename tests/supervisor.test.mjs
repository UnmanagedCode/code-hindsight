// supervisor.js over the fake docker: the start sequence, adoption and recreation, every named
// start failure, the health watch, stop/restart, and the SIGTERM path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDocker } from '../src/docker.js';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings.js';
import { createSecretsStore } from '../src/secrets.js';
import { createSupervisor } from '../src/supervisor.js';
import { resourceNames, ownerId } from '../src/containerSpec.js';
import { API_IMAGES, API_GPU_IMAGE, BUILD_HELPER, CP_IMAGE, LABELS, BASE_PATH, UPSTREAM_REVISION } from '../src/pins.js';
import { mkRoot, fakeEnv, seedDocker, dockerCalls, dockerState, setDockerState, fakeClock, waitFor, goodApiImage, goodCpImage, goodGpuImage, helperImage, CP_ID, API_ID, GPU_ID, FAKE_DOCKER } from './helpers.mjs';

const PREFIX = 'code-hindsight';
const names = resourceNames(PREFIX);

/** A recording stand-in for the relay (tunnel + proxy target) the supervisor starts and stops. */
function fakeRelay() {
  const calls = [];
  let target = null;
  return {
    calls,
    start: (addr, t) => { target = t; calls.push(['start', addr, t]); },
    stop: () => { target = null; calls.push(['stop']); },
    status: () => ({ target: target && { kind: target.kind, url: target.url }, tunnel: { state: 'connected', idle: 1, error: null, address: '127.0.0.1:18434' }, lastForward: null }),
  };
}

function make(t, { mode = '', sudoMode, seed, settings, allowSudo, fetchCcModels, clock = fakeClock(), health, watch = false, env: envOverride } = {}) {
  const r = mkRoot(t);
  seedDocker(r, seed);
  const env = { ...fakeEnv(r, { mode, sudoMode }), ...envOverride };
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  const settingsStore = createSettingsStore(r.dataDir);
  const s = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...settings };
  if (allowSudo !== undefined) s.docker = { allowSudo };
  settingsStore.save(s);
  const secrets = createSecretsStore(r.dataDir);
  const runDir = path.join(r.dataDir, 'run');
  fs.mkdirSync(runDir, { mode: 0o700 });
  const docker = createDocker({ env, allowSudo: () => settingsStore.get().docker.allowSudo, prefix: PREFIX, images: [API_IMAGES.full.ref, API_IMAGES.slim.ref, API_GPU_IMAGE, CP_IMAGE, BUILD_HELPER], runDir });
  const h = health ?? { api: 200, cp: 200 };
  const probes = [];
  const probe = async (url) => { probes.push(url); return url.includes(`:${settingsStore.get().network.apiPort}/`) ? h.api : h.cp; };
  let logins = 0;
  const cpSession = { token: async () => { logins++; return 't'; }, clear() {} };
  const owner = ownerId(r.dataDir);
  const relay = fakeRelay();
  const sup = createSupervisor({
    docker, settings: settingsStore, secrets, names, owner, dataDir: r.dataDir, detectBind: () => '127.0.0.1',
    fetchCcModels: fetchCcModels ?? (async () => { throw new Error('cc not expected'); }), cpSession, probe, clock, watch, relay,
    log: () => {},
  });
  return { r, env, sup, relay, settingsStore, secrets, docker, health: h, probes, owner, logins: () => logins };
}

const cmds = (r) => dockerCalls(r).map((a) => a[0] === 'network' || a[0] === 'volume' || a[0] === 'image' || a[0] === 'container' ? `${a[0]} ${a[1]}` : a[0]);
const errCode = (sup) => sup.status().error?.code;

// Spec 1: a backend start brings Hindsight up and reports ready only after the API and CP answer.
test('starts from nothing: network, volume, API, CP, health, ready', async (t) => {
  const { r, sup, probes, owner, secrets, logins } = make(t);
  await sup.ensureRunning();
  const st = sup.status();
  assert.equal(st.state, 'ready', JSON.stringify(st.error));
  assert.deepEqual(st.ports, { api: 18888, cp: 19999, relay: 18434 });
  assert.equal(st.bindAddress, '127.0.0.1');
  assert.equal(st.containers.api.state, 'running');
  assert.equal(st.images.api.ok, true);
  assert.deepEqual(probes.slice(0, 2), ['http://127.0.0.1:18888/health', 'http://127.0.0.1:19999/plugins/code-hindsight/api/health']);
  assert.equal(logins(), 1, 'signed in to the CP before ready');
  const s = dockerState(r);
  assert.equal(s.networks[names.network].Labels[LABELS.owner], owner);
  assert.equal(s.volumes[names.volume].Labels[LABELS.embeddings], 'local');
  const apiEnv = s.containers[names.api].Config.Env;
  assert.ok(apiEnv.includes(`HINDSIGHT_API_TENANT_API_KEY=${secrets.get().apiKey}`));
  assert.ok(s.containers[names.cp].Config.Env.includes(`HINDSIGHT_CP_ACCESS_KEY=${secrets.get().cpAccessKey}`));
  assert.deepEqual(sup.connection(), { apiUrl: 'http://127.0.0.1:18888', apiKey: secrets.get().apiKey });
  assert.deepEqual(sup.cpTarget(), { host: '127.0.0.1', port: 19999 });
});

// Spec 3 + decision 13: starting never pulls, loads, builds or removes images/volumes.
test('the start path never pulls, loads, builds or deletes', async (t) => {
  const { r, sup } = make(t, { seed: { images: {} } });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'IMAGE_MISSING');
  await sup.ensureRunning();
  for (const a of dockerCalls(r)) {
    assert.ok(!['pull', 'load', 'save', 'rmi', 'build', 'buildx'].includes(a[0]), a.join(' '));
    assert.ok(!(a[0] === 'volume' && a[1] === 'rm'), a.join(' '));
    assert.ok(!(a[0] === 'run' && a.includes('--rm')), a.join(' '));
  }
});

// Lifecycle: a backend restart adopts running containers with the same owner, spec and image.
test('a second backend adopts the running containers: no run, stop or rm', async (t) => {
  const first = make(t);
  await first.sup.ensureRunning();
  fs.writeFileSync(first.r.logPath, '');
  const again = createSupervisor({
    docker: first.docker, settings: first.settingsStore, secrets: first.secrets, names, owner: first.owner, dataDir: first.r.dataDir,
    detectBind: () => '127.0.0.1', fetchCcModels: async () => { throw new Error('x'); }, cpSession: { token: async () => 't', clear() {} }, relay: fakeRelay(),
    probe: async () => 200, clock: fakeClock(), watch: false, log: () => {},
  });
  await again.ensureRunning();
  assert.equal(again.status().state, 'ready');
  assert.deepEqual(cmds(first.r).filter((c) => ['run', 'stop', 'rm', 'start'].includes(c)), []);
});

// Lifecycle: settings drift → recreate; the volume is kept.
test('a changed spec recreates the container and keeps the volume', async (t) => {
  const { r, sup, settingsStore } = make(t);
  await sup.ensureRunning();
  const s = settingsStore.get();
  s.network.apiPort = 18889;
  settingsStore.save(s);
  assert.equal(sup.status().pendingRestart, true, 'saved settings differ from the running spec');
  fs.writeFileSync(r.logPath, '');
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  assert.equal(sup.status().pendingRestart, false);
  const c = cmds(r);
  assert.deepEqual(c.filter((x) => ['stop', 'rm', 'run'].includes(x)), ['stop', 'rm', 'run'], 'only the API container is replaced');
  assert.ok(!c.includes('volume rm') && !c.includes('volume create'));
  assert.ok(dockerState(r).containers[names.api].Ports.includes('127.0.0.1:18889:8888'));
});

test('a container on an outdated image ID is recreated', async (t) => {
  const { r, sup } = make(t);
  await sup.ensureRunning();
  // The tag re-pulled to new content.
  const other = `sha256:${'1'.repeat(64)}`;
  setDockerState(r, (s) => { s.images[API_IMAGES.full.ref] = { ...goodApiImage('full'), Id: other }; });
  fs.writeFileSync(r.logPath, '');
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  assert.equal(dockerState(r).containers[names.api].Image, other);
  assert.ok(cmds(r).includes('rm'));
});

test('an exited container with the same spec is started, not recreated', async (t) => {
  const { r, sup } = make(t);
  await sup.ensureRunning();
  await sup.stop();
  assert.equal(sup.status().state, 'stopped');
  assert.equal(dockerState(r).containers[names.api].State.Running, false, 'stop keeps the container');
  fs.writeFileSync(r.logPath, '');
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  assert.deepEqual(cmds(r).filter((x) => ['start', 'run', 'rm'].includes(x)), ['start', 'start']);
});

// Spec 1: named errors for each failed precondition; nothing is created on an image error.
test('missing or mismatched images are named and nothing is created', async (t) => {
  const missing = make(t, { seed: { images: {} } });
  await missing.sup.ensureRunning();
  assert.equal(errCode(missing.sup), 'IMAGE_MISSING');
  assert.equal(missing.sup.status().error.params.image, API_IMAGES.full.ref);
  assert.equal(missing.sup.status().error.action, 'pull');
  assert.ok(!cmds(missing.r).some((c) => ['run', 'network create', 'volume create'].includes(c)));

  const noCp = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage('full') } } });
  await noCp.sup.ensureRunning();
  assert.equal(errCode(noCp.sup), 'CP_IMAGE_MISSING');
  assert.equal(noCp.sup.status().error.action, 'build-cp');

  const otherBase = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage('full'), [CP_IMAGE]: { Id: CP_ID, Config: { Labels: { [LABELS.basePath]: '/hindsight', [LABELS.upstream]: UPSTREAM_REVISION } } } } } });
  await otherBase.sup.ensureRunning();
  assert.equal(errCode(otherBase.sup), 'CP_IMAGE_MISMATCH');
});

test('docker refused with sudo disallowed is DOCKER_DENIED; with sudo it starts via sudo', async (t) => {
  const denied = make(t, { mode: 'denied', allowSudo: false });
  await denied.sup.ensureRunning();
  assert.equal(errCode(denied.sup), 'DOCKER_DENIED');
  const viaSudo = make(t, { mode: 'denied' });
  await viaSudo.sup.ensureRunning();
  assert.equal(viaSudo.sup.status().state, 'ready');
  assert.equal(viaSudo.sup.status().docker.mode, 'sudo');
});

test('a docker run failure is DOCKER_FAILED with the stderr', async (t) => {
  const { sup } = make(t, { mode: 'fail-run' });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'DOCKER_FAILED');
  assert.match(sup.status().error.message, /injected failure of run/);
});

// Lifecycle: a port clash names the port and the setting, and removes nothing.
test('a port clash is PORT_IN_USE naming the setting; nothing is removed', async (t) => {
  const { r, sup } = make(t, { mode: 'port-clash' });
  await sup.ensureRunning();
  const e = sup.status().error;
  assert.equal(e.code, 'PORT_IN_USE');
  assert.deepEqual([e.params.port, e.params.setting, e.params.address], [18888, 'network.apiPort', '127.0.0.1']);
  assert.ok(!cmds(r).some((c) => ['rm', 'volume rm', 'stop'].includes(c)));
});

// Lifecycle: a same-named resource another cc owns is refused and never touched.
test('a foreign resource with our name is NAME_TAKEN and left alone', async (t) => {
  const net = make(t, { seed: { networks: { [names.network]: { Name: names.network, Labels: {} } } } });
  await net.sup.ensureRunning();
  assert.equal(errCode(net.sup), 'NAME_TAKEN');
  assert.equal(net.sup.status().error.params.kind, 'network');

  const ctr = make(t, { seed: { containers: { [names.api]: { Name: `/${names.api}`, Image: API_ID, Config: { Labels: { [LABELS.owner]: 'someone-else' } }, State: { Status: 'running', Running: true } } } } });
  await ctr.sup.ensureRunning();
  assert.equal(errCode(ctr.sup), 'NAME_TAKEN');
  assert.ok(!cmds(ctr.r).some((c) => ['rm', 'stop', 'run'].includes(c)), 'the foreign container is untouched');
});

// Lifecycle: switching embeddings on existing data is refused.
test('changed embeddings on an existing volume is EMBEDDINGS_CHANGED', async (t) => {
  const { sup, settingsStore, secrets } = make(t);
  await sup.ensureRunning();
  const s = settingsStore.get();
  secrets.setUserSecrets({ embeddingsApiKey: 'ek' });
  s.embeddings = { provider: 'openai', model: 'text-embedding-3-small', baseUrl: null };
  settingsStore.save(s);
  await sup.ensureRunning();
  const e = sup.status().error;
  assert.equal(e.code, 'EMBEDDINGS_CHANGED');
  assert.deepEqual([e.params.current, e.params.wanted], ['local', 'openai:text-embedding-3-small']);
});

test('invalid saved settings stop the start with the named refusal', async (t) => {
  const { sup } = make(t, { settings: { variant: 'slim' } });
  await sup.ensureRunning();
  assert.match(errCode(sup), /^SLIM_NEEDS_/);
  const other = make(t, { settings: { network: { bindAddress: null, apiPort: 1, cpPort: 19999 } } });
  await other.sup.ensureRunning();
  assert.equal(errCode(other.sup), 'SETTINGS_INVALID');
});

test('a cc-backend link failure stops the start with its code', async (t) => {
  const { sup } = make(t, { settings: { llm: { mode: 'cc-backend', provider: null, model: 'm', baseUrl: null, backendId: 'b' } }, fetchCcModels: async () => ({ backends: [] }) });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'CC_BACKEND_MISSING');
});

// Spec 1: an API that never answers is UNHEALTHY with its log tail (fake clock: no real wait).
test('an API that never answers is UNHEALTHY with a log tail', async (t) => {
  const { sup } = make(t, { health: { api: 0, cp: 200 } });
  await sup.ensureRunning();
  const e = sup.status().error;
  assert.equal(e.code, 'UNHEALTHY');
  assert.equal(e.params.role, 'api');
  assert.match(e.params.tail, /log line for code-hindsight-api/);
  assert.equal(e.action, 'restart');
});

test('a container that exits during start is CRASHED with its exit code', async (t) => {
  const { sup } = make(t, { mode: 'crash', health: { api: 0, cp: 0 } });
  await sup.ensureRunning();
  const e = sup.status().error;
  assert.equal(e.code, 'CRASHED');
  assert.equal(e.params.exitCode, 1);
});

// Lifecycle: the watch tells a crash from a hang.
test('watch: an exited API is CRASHED; a running but silent API is UNHEALTHY after repeated failures', async (t) => {
  const a = make(t);
  await a.sup.ensureRunning();
  setDockerState(a.r, (s) => { s.containers[names.api].State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 137 }; });
  a.health.api = 0;
  await a.sup.checkHealth();
  assert.equal(errCode(a.sup), 'CRASHED');
  assert.equal(a.sup.status().error.params.exitCode, 137);
  assert.equal(a.sup.cpTarget(), null, 'the proxy stops forwarding');

  const b = make(t);
  await b.sup.ensureRunning();
  b.health.api = 0;
  await b.sup.checkHealth();
  await b.sup.checkHealth();
  assert.equal(b.sup.status().state, 'ready', 'two failures are tolerated');
  await b.sup.checkHealth();
  assert.equal(errCode(b.sup), 'UNHEALTHY');

  // Restart recovers.
  b.health.api = 200;
  await b.sup.restart();
  assert.equal(b.sup.status().state, 'ready');
});

test('watch: an exited CP while the API is fine is CRASHED for the cp role', async (t) => {
  const { r, sup } = make(t);
  await sup.ensureRunning();
  setDockerState(r, (s) => { s.containers[names.cp].State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 1 }; });
  await sup.checkHealth();
  assert.equal(errCode(sup), 'CRASHED');
  assert.equal(sup.status().error.params.role, 'cp');
});

// Spec 4: stop on disable — SIGTERM stops the containers from a detached process and records it.
test('shutdown runs a detached docker stop and writes stopping.json', async (t) => {
  const { r, sup } = make(t);
  await sup.ensureRunning();
  const pid = await sup.shutdown();
  assert.ok(Number.isInteger(pid));
  const rec = JSON.parse(fs.readFileSync(path.join(r.dataDir, 'stopping.json'), 'utf8'));
  assert.equal(rec.pid, pid);
  assert.equal(fs.statSync(path.join(r.dataDir, 'stopping.json')).mode & 0o777, 0o600);
  await waitFor(() => dockerCalls(r).some((a) => a[0] === 'stop'));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'stop'), ['stop', '-t', '30', names.cp, names.api]);
});

// C1: a SIGTERM must still stop the containers when the invocation was reset (a sudo setting
// saved, a DOCKER_DENIED) or never resolved by this backend.
test('shutdown after docker.reset() still stops the containers with the last working invocation', async (t) => {
  const { r, sup, docker } = make(t, { mode: 'denied' });
  await sup.ensureRunning();
  assert.equal(sup.status().docker.mode, 'sudo');
  docker.reset();
  assert.equal(docker.info().mode, null);
  fs.writeFileSync(r.logPath, '');
  const pid = await sup.shutdown();
  assert.ok(Number.isInteger(pid));
  await waitFor(() => dockerCalls(r).some((a) => a[0] === 'stop'));
  assert.ok(fs.readFileSync(r.logPath, 'utf8').includes('"sudo":["-n"'), 'through sudo, as before the reset');
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'version'), 'no re-resolve needed');
});

// Round 2: switching sudo off is honoured at shutdown too: the remembered sudo invocation is
// dropped and plain docker is tried within the bounded resolve.
test('after sudo is switched off, shutdown never uses sudo: plain docker if it works, else a recorded failure', async (t) => {
  const refused = make(t, { mode: 'denied' });
  await refused.sup.ensureRunning();
  assert.equal(refused.sup.status().docker.mode, 'sudo');
  refused.settingsStore.save({ ...refused.settingsStore.get(), docker: { allowSudo: false } });
  refused.docker.reset();
  fs.writeFileSync(refused.r.logPath, '');
  assert.equal(await refused.sup.shutdown(), null);
  assert.doesNotMatch(fs.readFileSync(refused.r.logPath, 'utf8'), /"sudo"/, 'sudo was not run');
  assert.match(JSON.parse(fs.readFileSync(path.join(refused.r.dataDir, 'shutdown-failed.json'), 'utf8')).error, /permission denied|refused/i);

  const fixed = make(t, { mode: 'denied' });
  await fixed.sup.ensureRunning();
  fixed.settingsStore.save({ ...fixed.settingsStore.get(), docker: { allowSudo: false } });
  fixed.docker.reset();
  fixed.env.FAKE_DOCKER_MODE = ''; // the user got socket access instead
  fs.writeFileSync(fixed.r.logPath, '');
  assert.ok(Number.isInteger(await fixed.sup.shutdown()));
  await waitFor(() => dockerCalls(fixed.r).some((a) => a[0] === 'stop'));
  assert.doesNotMatch(fs.readFileSync(fixed.r.logPath, 'utf8'), /"sudo"/);
  assert.equal(dockerCalls(fixed.r).find((a) => a[0] === 'stop').length, 5);
});

test('shutdown before this backend resolved docker resolves it (bounded) and stops', async (t) => {
  const { r, sup } = make(t);
  const pid = await sup.shutdown();
  assert.ok(Number.isInteger(pid));
  await waitFor(() => dockerCalls(r).some((a) => a[0] === 'stop'));
});

test('a stop that cannot start records the failure instead of a pid-less stopping.json', async (t) => {
  const r0 = mkRoot(t);
  // A private copy of the fake that disappears after the start, so the detached spawn fails.
  const bin = path.join(r0.root, 'docker-copy.mjs');
  fs.copyFileSync(FAKE_DOCKER, bin);
  fs.chmodSync(bin, 0o755);
  const { r, sup } = make(t, { env: { CODE_HINDSIGHT_DOCKER_BIN: bin } });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  fs.rmSync(bin);
  assert.equal(await sup.shutdown(), null);
  assert.equal(fs.existsSync(path.join(r.dataDir, 'stopping.json')), false);
  const rec = JSON.parse(fs.readFileSync(path.join(r.dataDir, 'shutdown-failed.json'), 'utf8'));
  assert.match(rec.error, /could not start/);
  // The next backend shows it until Hindsight is ready again.
  const { sup: next } = makeOver(t, r);
  assert.match(next.status().lastShutdownFailure.error, /could not start/);
});

test('a daemon that cannot be reached at shutdown is recorded, not waited on', async (t) => {
  const { r, sup } = make(t, { mode: 'daemon-down' });
  assert.equal(await sup.shutdown(), null);
  assert.match(JSON.parse(fs.readFileSync(path.join(r.dataDir, 'shutdown-failed.json'), 'utf8')).error, /daemon/);
});

/** A second supervisor over an existing test root (a backend restart). */
function makeOver(t, r, { mode = '', timeouts } = {}) {
  const settingsStore = createSettingsStore(r.dataDir);
  const secrets = createSecretsStore(r.dataDir);
  const docker = createDocker({ env: fakeEnv(r, { mode }), allowSudo: () => true, prefix: PREFIX, images: [API_IMAGES.full.ref], runDir: path.join(r.dataDir, 'run') });
  const sup = createSupervisor({
    docker, settings: settingsStore, secrets, names, owner: ownerId(r.dataDir), dataDir: r.dataDir,
    detectBind: () => '127.0.0.1', fetchCcModels: async () => ({}), cpSession: { token: async () => 't', clear() {} }, relay: fakeRelay(),
    probe: async () => 200, clock: fakeClock(), watch: false, log: () => {}, timeouts,
  });
  return { sup, docker };
}

// Lifecycle (Restart race): a new backend waits for the previous one's detached stop to finish.
test('a pending detached stop is waited for before reconciling', async (t) => {
  const real = { now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 20))) };
  const { r, sup } = make(t, { clock: real });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
  t.after(() => child.kill());
  fs.writeFileSync(path.join(r.dataDir, 'stopping.json'), JSON.stringify({ pid: child.pid, at: Date.now() }));
  let exitedAt = 0;
  child.on('exit', () => { exitedAt = Date.now(); });
  const started = sup.ensureRunning();
  await new Promise((res) => setTimeout(res, 150));
  assert.deepEqual(dockerCalls(r), [], 'no docker call while the previous stop runs');
  await started;
  assert.ok(exitedAt > 0, 'waited for the pid');
  assert.equal(sup.status().state, 'ready');
  assert.equal(fs.existsSync(path.join(r.dataDir, 'stopping.json')), false);
});

// Invariant (spec 4/8): over a full lifecycle, every resource named in a docker call carries the
// prefix, and the plugin never connects anything to a network.
test('every docker call targets only prefixed resources and none connects a network', async (t) => {
  const { r, sup, settingsStore } = make(t);
  await sup.ensureRunning();
  const s = settingsStore.get();
  s.network.cpPort = 19998;
  settingsStore.save(s);
  await sup.ensureRunning();
  await sup.restart();
  await sup.stop();
  await sup.shutdown();
  await waitFor(() => dockerCalls(r).filter((a) => a[0] === 'stop').length >= 3);
  const named = new Set();
  for (const a of dockerCalls(r)) {
    assert.ok(!(a[0] === 'network' && a[1] === 'connect'), a.join(' '));
    if (a[0] === 'run') {
      named.add(a[a.indexOf('--name') + 1]);
      named.add(a[a.indexOf('--network') + 1]);
      if (a.includes('-v')) named.add(a[a.indexOf('-v') + 1].split(':')[0]);
    } else if (['start', 'stop', 'rm', 'logs'].includes(a[0]) || (['container', 'network', 'volume'].includes(a[0]) && a[1] !== 'ls')) {
      for (const x of a.slice(1)) if (!x.startsWith('-') && !/^\d+$/.test(x) && !['inspect', 'create', 'rm'].includes(x) && !x.includes('=')) named.add(x);
    }
  }
  assert.ok(named.size >= 4);
  for (const n of named) assert.ok(n.startsWith(`${PREFIX}-`), n);
});

// Directive: no ID check; an API image under the pinned tag runs whatever its ID and labels.
test('an API image under the pinned tag runs whatever its ID and labels', async (t) => {
  const odd = `sha256:${'f'.repeat(64)}`;
  const { r, sup } = make(t, { seed: { images: { [API_IMAGES.full.ref]: { Id: odd, Config: { Labels: {} } }, [CP_IMAGE]: goodCpImage() } } });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  assert.equal(dockerCalls(r).find((a) => a[0] === 'run' && a.includes(odd)).at(-1), odd);
});

// Directive: no CP trust; a CP image with this plugin's build labels runs whatever its ID.
test('a CP image under its tag with this plugin\'s build labels runs whatever its ID; no trust file is read or written', async (t) => {
  const swapped = make(t);
  setDockerState(swapped.r, (s) => { s.images[CP_IMAGE] = goodCpImage(`sha256:${'d'.repeat(64)}`); });
  await swapped.sup.ensureRunning();
  assert.equal(swapped.sup.status().state, 'ready', JSON.stringify(swapped.sup.status().error));
  assert.ok(!fs.existsSync(path.join(swapped.r.dataDir, 'trusted-cp.json')));
  assert.ok(!('trusted' in swapped.sup.status().images.cp));
});

// Containers run by the ID the tag resolved to at start.
test('both containers are run by image ID, never by tag', async (t) => {
  const { r, sup } = make(t);
  await sup.ensureRunning();
  const runs = dockerCalls(r).filter((a) => a[0] === 'run').map((a) => a.at(-1));
  assert.deepEqual(runs, [API_ID, CP_ID]);
});

/** A clock whose sleeps resolve only on tick(). */
function steppedClock() {
  let sleepers = [];
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res)); };
  return {
    now: () => 1_800_000_000_000,
    sleep: () => new Promise((res) => sleepers.push(res)),
    pending: () => sleepers.length,
    async tick() { const s = sleepers; sleepers = []; s.forEach((f) => f()); await flush(); },
  };
}

// C2: restarts never stack watch loops; the failure tolerance spans that many intervals.
test('after N restarts exactly one watch loop runs, and UNHEALTHY needs consecutive failing intervals', async (t) => {
  const clock = steppedClock();
  const { sup, health, probes } = make(t, { clock, watch: true });
  await sup.ensureRunning();
  for (let i = 0; i < 4; i++) await sup.restart();
  assert.equal(sup.status().state, 'ready');
  assert.equal(clock.pending(), 5, 'one sleeper per start so far');
  await clock.tick(); // stale loops wake, see they are stale, and end; the current one probes and sleeps
  await waitFor(() => clock.pending() === 1);
  const watchProbes = () => probes.filter((u) => u.endsWith(':18888/health')).length;
  let before = watchProbes();
  await clock.tick();
  await waitFor(() => clock.pending() === 1);
  assert.equal(watchProbes() - before, 1, 'one probe per interval');

  health.api = 0;
  for (let i = 1; i <= 2; i++) {
    before = watchProbes();
    await clock.tick();
    await waitFor(() => clock.pending() === 1);
    assert.equal(watchProbes() - before, 1);
    assert.equal(sup.status().state, 'ready', `still ready after ${i} failing interval(s)`);
  }
  await clock.tick();
  await waitFor(() => sup.status().state === 'error');
  assert.equal(errCode(sup), 'UNHEALTHY');
  before = watchProbes();
  await clock.tick();
  assert.equal(clock.pending(), 0, 'the stopped loop ends at its next wake');
  assert.equal(watchProbes(), before, 'without probing');
});


const OLLAMA_CC = { backends: [{ id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [] }] };
const ollamaLink = { llm: { mode: 'cc-backend', provider: null, model: 'qwen3:4b', baseUrl: null, backendId: 'ollama', maxConcurrent: null } };
const makeLinked = (t, o = {}) => make(t, { settings: ollamaLink, fetchCcModels: async () => OLLAMA_CC, ...o });

// OL9: with an Ollama link the relay is created before the API, and the tunnel dials the published port.
test('OL9: an Ollama link creates the relay before the API and starts the tunnel at bind:relayPort', async (t) => {
  const { r, sup, relay, secrets } = makeLinked(t);
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  const runs = dockerCalls(r).filter((a) => a[0] === 'run').map((a) => a[a.indexOf('--name') + 1]);
  assert.deepEqual(runs, [names.relay, names.api, names.cp]);
  assert.deepEqual(relay.calls, [['start', { host: '127.0.0.1', port: 18434 }, { kind: 'ollama' }]]);
  const st = dockerState(r);
  assert.ok(st.containers[names.relay].Config.Env.includes(`RELAY_KEY=${secrets.get().relayKey}`));
  const apiEnv = st.containers[names.api].Config.Env;
  assert.ok(apiEnv.includes('HINDSIGHT_API_LLM_PROVIDER=ollama'));
  assert.ok(apiEnv.includes('HINDSIGHT_API_LLM_BASE_URL=http://ollama:11434/v1'));
  assert.equal(sup.status().containers.relay.state, 'running');
  assert.equal(sup.status().relay.tunnel.state, 'connected');
});

test('OL9: without an Ollama link there is no relay and no ollama status', async (t) => {
  const { r, sup, relay } = make(t);
  await sup.ensureRunning();
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'run' && a.includes(names.relay)));
  assert.equal(sup.status().relay, null);
  assert.deepEqual(relay.calls, [['stop']]);
});

test('OL9: unlinking removes the relay container and stops the tunnel', async (t) => {
  const { r, sup, relay, settingsStore } = makeLinked(t);
  await sup.ensureRunning();
  assert.ok(dockerState(r).containers[names.relay]);
  const s = settingsStore.get();
  s.llm = { mode: 'none', provider: null, model: null, baseUrl: null, backendId: null, maxConcurrent: null };
  settingsStore.save(s);
  await sup.ensureRunning();
  assert.equal(dockerState(r).containers[names.relay], undefined);
  assert.deepEqual(relay.calls.at(-1), ['stop']);
  assert.equal(sup.status().relay, null);
});

test('OL9: stop and shutdown include the relay and stop the tunnel', async (t) => {
  const { r, sup, relay } = makeLinked(t);
  await sup.ensureRunning();
  await sup.stop();
  assert.equal(dockerState(r).containers[names.relay].State.Running, false);
  assert.deepEqual(relay.calls.at(-1), ['stop']);
  await sup.ensureRunning();
  fs.writeFileSync(r.logPath, '');
  await sup.shutdown();
  await waitFor(() => dockerCalls(r).some((a) => a[0] === 'stop'));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'stop'), ['stop', '-t', '30', names.cp, names.api, names.relay]);
  assert.deepEqual(relay.calls.at(-1), ['stop']);
});

test('OL9: a relay that exited while the API is fine is CRASHED for the relay role', async (t) => {
  const { r, sup } = makeLinked(t);
  await sup.ensureRunning();
  setDockerState(r, (s) => { s.containers[names.relay].State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 1 }; });
  await sup.checkHealth();
  assert.equal(errCode(sup), 'CRASHED');
  assert.equal(sup.status().error.params.role, 'relay');
});

test('OL9: a clash on the relay port is PORT_IN_USE naming network.relayPort', async (t) => {
  const { sup } = makeLinked(t, { mode: 'port-clash' });
  await sup.ensureRunning();
  const e = sup.status().error;
  assert.equal(e.code, 'PORT_IN_USE');
  assert.deepEqual([e.params.port, e.params.setting], [18434, 'network.relayPort']);
});

test('OL9: with an Ollama link every docker call stays on prefixed resources and none connects a network', async (t) => {
  const { r, sup } = makeLinked(t);
  await sup.ensureRunning();
  await sup.restart();
  await sup.stop();
  for (const a of dockerCalls(r)) {
    assert.ok(!(a[0] === 'network' && a[1] === 'connect'), a.join(' '));
    if (a[0] === 'run') {
      assert.ok(a[a.indexOf('--name') + 1].startsWith(`${PREFIX}-`));
      assert.ok(a[a.indexOf('--network') + 1].startsWith(`${PREFIX}-`));
    }
  }
});

// OL5: a changed cap or relay port on a running stack is a pending restart.
test('OL5: changing maxConcurrent or relayPort on a ready stack flags pendingRestart', async (t) => {
  const { sup, settingsStore } = make(t);
  await sup.ensureRunning();
  for (const change of [(s) => { s.llm.maxConcurrent = 2; }, (s) => { s.network.relayPort = 20000; }]) {
    const s = settingsStore.get();
    change(s);
    settingsStore.save(s);
    assert.equal(sup.status().pendingRestart, true);
    await sup.ensureRunning();
    assert.equal(sup.status().pendingRestart, false);
  }
});

// C-1: a relay left running by an earlier process is stopped at shutdown even when this process's
// start failed before it knew about any link (the decision comes from the container, not from memory).
test('C-1: shutdown stops a relay a previous process left running although this start failed early', async (t) => {
  const first = makeLinked(t);
  await first.sup.ensureRunning();
  assert.equal(dockerState(first.r).containers[names.relay].State.Running, true);
  const { sup } = makeOver(t, first.r); // its fetchCcModels answers {}: the start fails with CC_ROUTE_CHANGED
  await sup.ensureRunning();
  assert.equal(sup.status().error.code, 'CC_ROUTE_CHANGED');
  fs.writeFileSync(first.r.logPath, '');
  await sup.shutdown();
  await waitFor(() => dockerCalls(first.r).some((a) => a[0] === 'stop'));
  assert.deepEqual(dockerCalls(first.r).find((a) => a[0] === 'stop'), ['stop', '-t', '30', names.cp, names.api, names.relay]);
});

test('C-1: shutdown leaves a relay out when none of ours is running', async (t) => {
  const { r, sup } = make(t);
  await sup.ensureRunning();
  fs.writeFileSync(r.logPath, '');
  await sup.shutdown();
  await waitFor(() => dockerCalls(r).some((a) => a[0] === 'stop'));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'stop'), ['stop', '-t', '30', names.cp, names.api]);
});

// C-2: a start that stop() cancels while the LLM env is being read never brings the tunnel up.
test('C-2: a start cancelled by stop() ends with the tunnel stopped, never started', async (t) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { sup, relay, r } = makeLinked(t, { fetchCcModels: async () => { await gate; return OLLAMA_CC; } });
  const starting = sup.ensureRunning();
  await waitFor(() => dockerState(r).networks[names.network]); // the start has passed the network step
  const stopping = sup.stop();
  release();
  await Promise.all([starting, stopping]);
  assert.equal(sup.status().state, 'stopped');
  assert.equal(relay.calls.some((c) => c[0] === 'start'), false, JSON.stringify(relay.calls));
  assert.deepEqual(relay.calls.at(-1), ['stop']);
  assert.equal(sup.status().relay, null);
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'run' && a.includes(names.relay)), 'no relay container was created either');
});

// LB10..LB12: a loopback cc backend row is linked through the relay.
const SENTINEL = 'row-token-SENTINEL-77';
const loopRow = (token = SENTINEL, port = 18765) => ({ id: 'opencode', label: 'OpenCode', template: 'claude', env: [{ key: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${port}` }, { key: 'ANTHROPIC_AUTH_TOKEN', value: token }] });
const directRow = { id: 'remote', label: 'Remote', template: 'anthropic', env: [{ key: 'ANTHROPIC_BASE_URL', value: 'https://llm.example.com/a' }, { key: 'ANTHROPIC_AUTH_TOKEN', value: 'public-token' }] };
const linkTo = (backendId, model = 'glm-5') => ({ llm: { mode: 'cc-backend', provider: null, model, baseUrl: null, backendId, maxConcurrent: null } });
const relayRuns = (r) => dockerCalls(r).filter((a) => a[0] === 'run' && a.includes(names.relay));

test('LB10: a loopback link runs the relay with the cc-backend alias, starts the tunnel with the target, and status has no token', async (t) => {
  const rows = { backends: [loopRow()] };
  const { r, sup, relay } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  const [run] = relayRuns(r);
  assert.equal(run[run.indexOf('--network-alias') + 1], 'cc-backend');
  assert.deepEqual(relay.calls, [['start', { host: '127.0.0.1', port: 18434 }, { kind: 'anthropic-loopback', url: 'http://127.0.0.1:18765', auth: { header: 'authorization', value: `Bearer ${SENTINEL}` } }]]);
  const apiEnv = dockerState(r).containers[names.api].Config.Env;
  assert.ok(apiEnv.includes('HINDSIGHT_API_LLM_BASE_URL=http://cc-backend:8080'));
  assert.deepEqual(sup.status().relay.target, { kind: 'anthropic-loopback', url: 'http://127.0.0.1:18765' });
  assert.equal(JSON.stringify(sup.status()).includes(SENTINEL), false);
});

test('LB10b: switching from a loopback row to an Ollama row recreates the relay and keeps the tunnel address', async (t) => {
  const rows = { backends: [loopRow(), ...OLLAMA_CC.backends] };
  const { r, sup, relay, settingsStore } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  const first = dockerState(r).containers[names.relay].Config.Labels['io.code-hindsight.spec'];
  const s = settingsStore.get();
  s.llm = { ...s.llm, backendId: 'ollama', model: 'qwen3:4b' };
  settingsStore.save(s);
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  assert.equal(relayRuns(r).length, 2, 'the relay was created again');
  assert.notEqual(dockerState(r).containers[names.relay].Config.Labels['io.code-hindsight.spec'], first);
  const starts = relay.calls.filter((c) => c[0] === 'start');
  assert.deepEqual(starts.map((c) => c[1]), [{ host: '127.0.0.1', port: 18434 }, { host: '127.0.0.1', port: 18434 }]);
  assert.deepEqual(starts.at(-1)[2], { kind: 'ollama' });
});

test('LB10c: switching from a loopback row to a direct row stops the tunnel and removes the relay', async (t) => {
  const rows = { backends: [loopRow(), directRow] };
  const { r, sup, relay, settingsStore } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  assert.ok(dockerState(r).containers[names.relay]);
  const s = settingsStore.get();
  s.llm = { ...s.llm, backendId: 'remote' };
  settingsStore.save(s);
  await sup.ensureRunning();
  assert.equal(dockerState(r).containers[names.relay], undefined);
  assert.deepEqual(relay.calls.at(-1), ['stop']);
  assert.equal(sup.status().relay, null);
});

test('LB11: a token changed in cc is used at the next start, raises no pendingRestart and does not recreate the API', async (t) => {
  const rows = { backends: [loopRow('old-token')] };
  const { r, sup, relay } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  const apiRuns = () => dockerCalls(r).filter((a) => a[0] === 'run' && a.includes(names.api)).length;
  assert.equal(apiRuns(), 1);
  rows.backends = [loopRow('new-token', 18999)];
  assert.equal(sup.status().pendingRestart, false);
  assert.deepEqual(relay.calls.filter((c) => c[0] === 'start').map((c) => c[2].auth.value), ['Bearer old-token'], 'not read earlier');
  await sup.restart();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  assert.deepEqual(relay.calls.filter((c) => c[0] === 'start').map((c) => c[2].auth.value), ['Bearer old-token', 'Bearer new-token']);
  assert.equal(relay.calls.filter((c) => c[0] === 'start').at(-1)[2].url, 'http://127.0.0.1:18999');
  assert.equal(apiRuns(), 1, 'the API env names only the relay, so it is adopted');
  assert.equal(sup.status().pendingRestart, false);
});

test('LB12: the row token appears in no docker call and no container env', async (t) => {
  const rows = { backends: [loopRow()] };
  const { r, sup } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  assert.equal(JSON.stringify(dockerCalls(r)).includes(SENTINEL), false);
  assert.equal(JSON.stringify(dockerState(r).containers).includes(SENTINEL), false);
});

// LB11b: a start that fails after the relay began undoes it: no target, no relay container, status agrees.
test('LB11b: a failure after relay.start stops the relay and removes its container, so status.relay is null', async (t) => {
  const rows = { backends: [loopRow()] };
  const { r, sup, relay } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows, health: { api: 0, cp: 200 } });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'error');
  assert.equal(relay.calls.filter((c) => c[0] === 'start').length, 1);
  assert.deepEqual(relay.calls.at(-1), ['stop']);
  assert.equal(dockerState(r).containers[names.relay], undefined, 'the relay container is gone');
  assert.equal(sup.status().relay, null);
});

// LB11c: a start that fails before the relay step leaves the running loopback link as it was.
test('LB11c: a reconcile that fails before the relay step keeps the tunnel, status.relay and the relay container', async (t) => {
  const rows = { backends: [loopRow()] };
  const { r, sup, relay, settingsStore } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  const before = relay.calls.length;
  rows.backends = []; // cc no longer has the row: composeLlmEnv fails before the relay step
  const s = settingsStore.get();
  s.llm.maxConcurrent = 2; // Apply & restart: a reconcile of the running stack
  settingsStore.save(s);
  await sup.ensureRunning();
  assert.equal(sup.status().error.code, 'CC_BACKEND_MISSING');
  assert.equal(relay.calls.slice(before).some((c) => c[0] === 'stop'), false, JSON.stringify(relay.calls.slice(before)));
  assert.notEqual(sup.status().relay, null);
  assert.ok(dockerState(r).containers[names.relay], 'the relay container stays');
});

// LB11d: an unlink whose relay removal fails still ends with no relay in status, and the removal error is what is reported.
test('LB11d: a failing relay removal while unlinking leaves status.relay null and surfaces the original error', async (t) => {
  const rows = { backends: [loopRow(), directRow] };
  const { sup, relay, settingsStore, env } = make(t, { settings: linkTo('opencode'), fetchCcModels: async () => rows });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  const s = settingsStore.get();
  s.llm = { ...s.llm, backendId: 'remote' };
  settingsStore.save(s);
  env.FAKE_DOCKER_MODE = 'fail-rm';
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'error');
  assert.match(sup.status().error.message, /injected failure of rm/);
  assert.deepEqual(relay.calls.at(-1), ['stop']);
  assert.equal(sup.status().relay, null);
});

const stopArgs = (r) => dockerCalls(r).find((a) => a[0] === 'stop');

// R2-C2: the shutdown's look at the relay is bounded, so a hung `docker inspect` cannot hold up the detached stop.
test('R2-C2: a hung relay inspect still lets the detached stop run promptly, and it includes the relay', async (t) => {
  const first = makeLinked(t);
  await first.sup.ensureRunning();
  setDockerState(first.r, (st) => { st.hangRelayInspect = true; });
  const { sup, docker } = makeOver(t, first.r, { timeouts: { shutdownProbeMs: 200 } });
  await docker.resolve();
  fs.writeFileSync(first.r.logPath, '');
  const started = Date.now();
  const pid = await sup.shutdown();
  assert.ok(Number.isInteger(pid));
  assert.ok(Date.now() - started < 5_000, 'bounded by shutdownProbeMs, not docker inspect\'s own timeout');
  await waitFor(() => stopArgs(first.r));
  assert.deepEqual(stopArgs(first.r), ['stop', '-t', '30', names.cp, names.api, names.relay]);
});

// R2-C3 (the declared C-1 limit): with docker not resolved, only this process's own link counts.
test('R2-C3: with docker unresolved, a relay left running by an earlier process is not named in the stop', async (t) => {
  const first = makeLinked(t);
  await first.sup.ensureRunning();
  const { sup, docker } = makeOver(t, first.r);
  assert.equal(docker.info().mode, null);
  fs.writeFileSync(first.r.logPath, '');
  await sup.shutdown();
  await waitFor(() => stopArgs(first.r));
  assert.deepEqual(stopArgs(first.r), ['stop', '-t', '30', names.cp, names.api]);
});

// R2-C3: an inspect that fails for any reason but "no such container" counts as may-run.
test('R2-C3: a failing relay inspect counts as may-run: the relay is named in the stop', async (t) => {
  const first = makeLinked(t);
  await first.sup.ensureRunning();
  const { sup, docker } = makeOver(t, first.r, { mode: 'fail-inspect-container' });
  await docker.resolve();
  fs.writeFileSync(first.r.logPath, '');
  await sup.shutdown();
  await waitFor(() => stopArgs(first.r));
  assert.deepEqual(stopArgs(first.r), ['stop', '-t', '30', names.cp, names.api, names.relay]);
});

// --- GPU compute ---

/** Every image present, the GPU image too (labelled as build-gpu labels it). */
const gpuSeed = (extra = {}) => ({ images: { [API_IMAGES.full.ref]: goodApiImage('full'), [API_IMAGES.slim.ref]: goodApiImage('slim'), [CP_IMAGE]: goodCpImage(), [BUILD_HELPER]: helperImage(), [API_GPU_IMAGE]: goodGpuImage(), ...extra } });
const apiRuns = (r) => dockerCalls(r).filter((a) => a[0] === 'run' && a.includes(names.api));
const setCompute = (settingsStore, compute) => { const s = settingsStore.get(); s.compute = compute; settingsStore.save(s); };

// GPU4: a GPU start needs the labelled GPU image, and says so before any container is touched.
test('GPU4: GPU mode without the GPU image is GPU_IMAGE_MISSING (action build-gpu) and touches no container', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' } });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'GPU_IMAGE_MISSING');
  assert.equal(sup.status().error.action, 'build-gpu');
  assert.equal(sup.status().error.params.image, API_GPU_IMAGE);
  assert.equal(sup.status().images.gpu.present, false);
  assert.ok(!cmds(r).some((c) => ['run', 'rm', 'stop', 'start', 'network create', 'volume create'].includes(c)));
});

test('GPU4: a GPU image without this plugin\'s build labels is GPU_IMAGE_MISMATCH and touches no container', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed({ [API_GPU_IMAGE]: { Id: GPU_ID, Config: { Labels: { [LABELS.upstream]: UPSTREAM_REVISION, [LABELS.cuda]: 'cu126' } } } }) });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'GPU_IMAGE_MISMATCH');
  assert.equal(sup.status().error.action, 'build-gpu');
  assert.ok(!cmds(r).some((c) => ['run', 'rm', 'stop', 'start'].includes(c)));
});

test('GPU4: GPU mode runs the GPU image by ID with every GPU, and needs no official full image', async (t) => {
  const seed = gpuSeed();
  delete seed.images[API_IMAGES.full.ref];
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  const api = dockerState(r).containers[names.api];
  assert.equal(api.Image, GPU_ID);
  assert.equal(api.RunArgs[api.RunArgs.indexOf('--gpus') + 1], 'all');
  assert.ok(api.Config.Env.includes('HINDSIGHT_API_RERANKER_LOCAL_FP16=true'));
  assert.deepEqual(sup.status().compute, { mode: 'gpu', devices: { embeddings: 'cuda', reranker: 'cuda' } });
  assert.equal(sup.status().images.gpu.ok, true);
});

// GPU5: a daemon that cannot attach a GPU ends the start; nothing falls back to the CPU.
test('GPU5: a daemon without GPU support is GPU_UNAVAILABLE and no CPU API container is created', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed(), mode: 'no-gpu' });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'GPU_UNAVAILABLE');
  assert.match(sup.status().error.message, /could not select device driver/);
  assert.equal(sup.status().error.action, 'settings');
  assert.ok(apiRuns(r).length >= 1 && apiRuns(r).every((a) => a.includes('--gpus')), 'every API run asked for the GPU');
  assert.equal(dockerState(r).containers[names.api].State.Running, false);
  // The start is re-tried (the created container is started again) with the same refusal.
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'GPU_UNAVAILABLE');
});

// GPU6: the models' own start lines must name cuda, or the API is stopped.
test('GPU6: models that loaded on the CPU are GPU_NOT_USED; the API is stopped and the state is not ready', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed() });
  setDockerState(r, (s) => { s.gpuDevice = 'cpu'; });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'error');
  assert.equal(errCode(sup), 'GPU_NOT_USED');
  assert.deepEqual(sup.status().error.params, { embeddings: 'cpu', reranker: 'cpu' });
  assert.equal(dockerState(r).containers[names.api].State.Running, false, 'the API was stopped');
  assert.ok(dockerState(r).containers[names.api], 'and kept');
  assert.equal(sup.connection(), null);
  assert.equal(sup.status().compute.devices, null);
  const logs = dockerCalls(r).find((a) => a[0] === 'logs');
  assert.ok(logs.includes('--since') && logs.includes('--until'), 'reads the start\'s log window');
});

test('GPU6: a fresh API with no start lines is GPU_NOT_USED, not recreated', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed() });
  setDockerState(r, (s) => { s.gpuStartLines = false; });
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'GPU_NOT_USED');
  assert.deepEqual(sup.status().error.params, { embeddings: null, reranker: null });
  assert.equal(apiRuns(r).length, 1);
  assert.equal(dockerState(r).containers[names.api].State.Running, false);
});

// GPU6 (log rotation): an adopted, long-running GPU API whose start lines rotated out of its log
// is recreated so the check reads a fresh start, never stopped for the missing lines alone; an
// adopted API whose lines name the CPU is GPU_NOT_USED and not recreated.
test('GPU6: an adopted API whose start lines rotated away is recreated and checked afresh', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed() });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  setDockerState(r, (s) => { s.containers[names.api].Log = 'INFO POST /v1/default/banks/x/memories/recall 200'; });
  fs.writeFileSync(r.logPath, '');
  await sup.restart(); // stops and starts again: the stopped API is started, so its lines are fresh
  assert.equal(sup.status().state, 'ready');
  // Now the adopted case proper: a running API (as a new backend finds it) with no start lines.
  setDockerState(r, (s) => { s.containers[names.api].Log = 'INFO POST /v1/default/banks/x/memories/recall 200'; });
  fs.writeFileSync(r.logPath, '');
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  assert.deepEqual(cmds(r).filter((c) => ['stop', 'rm', 'run'].includes(c)), ['stop', 'rm', 'run'], 'only the API was recreated');
  assert.equal(apiRuns(r).length, 1);
  assert.deepEqual(sup.status().compute.devices, { embeddings: 'cuda', reranker: 'cuda' });
  assert.ok(!cmds(r).includes('volume rm'));
});

test('GPU6: an adopted API whose start lines name the CPU is GPU_NOT_USED and not recreated', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed() });
  await sup.ensureRunning();
  setDockerState(r, (s) => { s.containers[names.api].Log = 'Embeddings: local provider initialized (dim: 384, device: cpu)\nReranker: local provider initialized (device: cpu, max_concurrent=4)'; });
  fs.writeFileSync(r.logPath, '');
  await sup.ensureRunning();
  assert.equal(errCode(sup), 'GPU_NOT_USED');
  assert.ok(!cmds(r).includes('rm') && !cmds(r).includes('run'));
  assert.equal(dockerState(r).containers[names.api].State.Running, false);
});

// GPU7: switching modes recreates only the API, on the same volume; the CP is adopted.
test('GPU7: CPU→GPU restart recreates only the API on the GPU image; GPU→CPU back; the volume is never removed', async (t) => {
  const { r, sup, settingsStore } = make(t, { seed: gpuSeed() });
  await sup.ensureRunning();
  assert.deepEqual(sup.status().compute, { mode: 'cpu', devices: null });
  assert.equal(dockerState(r).containers[names.api].Image, API_ID);
  setCompute(settingsStore, 'gpu');
  assert.equal(sup.status().pendingRestart, true);
  fs.writeFileSync(r.logPath, '');
  await sup.restart();
  assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
  assert.equal(sup.status().pendingRestart, false);
  let api = dockerState(r).containers[names.api];
  assert.equal(api.Image, GPU_ID);
  assert.ok(api.RunArgs.includes('--gpus'));
  assert.deepEqual(api.Mounts, [names.volume]);
  assert.deepEqual(dockerCalls(r).filter((a) => a[0] === 'rm' || a[0] === 'run').map((a) => a.find((x) => x.startsWith('code-hindsight-'))), [names.api, names.api], 'only the API is removed and run');
  assert.deepEqual(sup.status().compute.devices, { embeddings: 'cuda', reranker: 'cuda' });

  setCompute(settingsStore, 'cpu');
  fs.writeFileSync(r.logPath, '');
  await sup.restart();
  assert.equal(sup.status().state, 'ready');
  api = dockerState(r).containers[names.api];
  assert.equal(api.Image, API_ID);
  assert.equal(api.RunArgs.includes('--gpus'), false);
  assert.deepEqual(api.Mounts, [names.volume]);
  assert.deepEqual(sup.status().compute, { mode: 'cpu', devices: null });
  assert.ok(!cmds(r).includes('volume rm') && !cmds(r).includes('volume create'));
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'logs' && a.includes('--since')), 'CPU mode reads no device lines');
});

test('GPU7: CPU→GPU before the GPU image exists stops the stack and refuses GPU_IMAGE_MISSING; nothing is removed', async (t) => {
  const { r, sup, settingsStore } = make(t);
  await sup.ensureRunning();
  setCompute(settingsStore, 'gpu');
  fs.writeFileSync(r.logPath, '');
  await sup.restart();
  assert.equal(errCode(sup), 'GPU_IMAGE_MISSING');
  assert.ok(!cmds(r).some((c) => ['rm', 'run', 'volume rm'].includes(c)));
  assert.equal(dockerState(r).containers[names.api].Image, API_ID, 'the CPU container is kept');
});

// GPU8: Docker restarting the API (on-failure) re-runs the check: a GPU lost mid-run is not missed.
test('GPU8: a watch tick after the API restarted on the CPU is GPU_NOT_USED and stops it; an unchanged start reads no log', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed() });
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  fs.writeFileSync(r.logPath, '');
  await sup.checkHealth();
  assert.equal(sup.status().state, 'ready');
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'logs'), 'same start: no log read');
  setDockerState(r, (s) => {
    s.containers[names.api].State.StartedAt = '2026-01-01T01:00:00.000Z';
    s.containers[names.api].Log = 'Embeddings: local provider initialized (dim: 384, device: cpu)\nReranker: local provider initialized (device: cpu, max_concurrent=4)';
  });
  await sup.checkHealth();
  assert.equal(errCode(sup), 'GPU_NOT_USED');
  assert.equal(dockerState(r).containers[names.api].State.Running, false);
});

test('GPU8: a watch tick after the API restarted on cuda stays ready', async (t) => {
  const { r, sup } = make(t, { settings: { compute: 'gpu' }, seed: gpuSeed() });
  await sup.ensureRunning();
  setDockerState(r, (s) => { s.containers[names.api].State.StartedAt = '2026-01-01T01:00:00.000Z'; });
  await sup.checkHealth();
  assert.equal(sup.status().state, 'ready');
  assert.deepEqual(sup.status().compute.devices, { embeddings: 'cuda', reranker: 'cuda' });
});
