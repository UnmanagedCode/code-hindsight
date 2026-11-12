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
import { API_IMAGES, BUILD_HELPER_IMAGE, CP_IMAGE, LABELS } from '../src/pins.js';
import { mkRoot, fakeEnv, seedDocker, dockerCalls, dockerState, setDockerState, fakeClock, waitFor, goodApiImage } from './helpers.mjs';

const PREFIX = 'code-hindsight';
const names = resourceNames(PREFIX);

function make(t, { mode = '', sudoMode, seed, settings, allowSudo, fetchCcModels, clock = fakeClock(), health } = {}) {
  const r = mkRoot(t);
  seedDocker(r, seed);
  const env = fakeEnv(r, { mode, sudoMode });
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  const settingsStore = createSettingsStore(r.dataDir);
  const s = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...settings };
  if (allowSudo !== undefined) s.docker = { allowSudo };
  settingsStore.save(s);
  const secrets = createSecretsStore(r.dataDir);
  const runDir = path.join(r.dataDir, 'run');
  fs.mkdirSync(runDir, { mode: 0o700 });
  const docker = createDocker({ env, allowSudo: () => settingsStore.get().docker.allowSudo, prefix: PREFIX, images: [API_IMAGES.full.ref, API_IMAGES.slim.ref, CP_IMAGE, BUILD_HELPER_IMAGE], runDir });
  const h = health ?? { api: 200, cp: 200 };
  const probes = [];
  const probe = async (url) => { probes.push(url); return url.includes(`:${settingsStore.get().network.apiPort}/`) ? h.api : h.cp; };
  let logins = 0;
  const cpSession = { token: async () => { logins++; return 't'; }, clear() {} };
  const owner = ownerId(r.dataDir);
  const sup = createSupervisor({
    docker, settings: settingsStore, secrets, names, owner, dataDir: r.dataDir, detectBind: () => '127.0.0.1',
    fetchCcModels: fetchCcModels ?? (async () => { throw new Error('cc not expected'); }), cpSession, probe, clock, watch: false,
    log: () => {},
  });
  return { r, env, sup, settingsStore, secrets, docker, health: h, probes, owner, logins: () => logins };
}

const cmds = (r) => dockerCalls(r).map((a) => a[0] === 'network' || a[0] === 'volume' || a[0] === 'image' || a[0] === 'container' ? `${a[0]} ${a[1]}` : a[0]);
const errCode = (sup) => sup.status().error?.code;

// Spec 1: a backend start brings Hindsight up and reports ready only after the API and CP answer.
test('starts from nothing: network, volume, API, CP, health, ready', async (t) => {
  const { r, sup, probes, owner, secrets, logins } = make(t);
  await sup.ensureRunning();
  const st = sup.status();
  assert.equal(st.state, 'ready', JSON.stringify(st.error));
  assert.deepEqual(st.ports, { api: 18888, cp: 19999 });
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
    detectBind: () => '127.0.0.1', fetchCcModels: async () => { throw new Error('x'); }, cpSession: { token: async () => 't', clear() {} },
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
  setDockerState(r, (s) => { s.images[API_IMAGES.full.ref] = { ...goodApiImage('full'), Id: 'sha256:newer' }; });
  fs.writeFileSync(r.logPath, '');
  await sup.ensureRunning();
  assert.equal(sup.status().state, 'ready');
  assert.equal(dockerState(r).containers[names.api].Image, 'sha256:newer');
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

  const wrongRev = make(t, { seed: { images: { [API_IMAGES.full.ref]: { Id: 'x', Config: { Labels: { 'org.opencontainers.image.version': '1.2.0', 'org.opencontainers.image.revision': 'abc' } } } } } });
  await wrongRev.sup.ensureRunning();
  assert.equal(errCode(wrongRev.sup), 'IMAGE_MISMATCH');

  const noCp = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage('full') } } });
  await noCp.sup.ensureRunning();
  assert.equal(errCode(noCp.sup), 'CP_IMAGE_MISSING');
  assert.equal(noCp.sup.status().error.action, 'build-cp');

  const otherBase = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage('full'), [CP_IMAGE]: { Id: 'c', Config: { Labels: { [LABELS.basePath]: '/hindsight', [LABELS.upstream]: 'v1.2.1' } } } } } });
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

  const ctr = make(t, { seed: { containers: { [names.api]: { Name: `/${names.api}`, Image: 'sha256:api-full', Config: { Labels: { [LABELS.owner]: 'someone-else' } }, State: { Status: 'running', Running: true } } } } });
  await ctr.sup.ensureRunning();
  assert.equal(errCode(ctr.sup), 'NAME_TAKEN');
  assert.ok(!cmds(ctr.r).some((c) => ['rm', 'stop', 'run'].includes(c)), 'the foreign container is untouched');
});

// Lifecycle: switching embeddings on existing data is refused.
test('changed embeddings on an existing volume is EMBEDDINGS_CHANGED', async (t) => {
  const { sup, settingsStore } = make(t);
  await sup.ensureRunning();
  const s = settingsStore.get();
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

test('shutdown before docker was ever resolved does nothing', async (t) => {
  const { r, sup } = make(t);
  assert.equal(await sup.shutdown(), null);
  assert.deepEqual(dockerCalls(r), []);
});

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
