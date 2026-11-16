// docker.js: how docker is invoked (direct, or `sudo -n` when allowed), how failures are named,
// and the guards that keep it off resources this plugin does not own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDocker, classifyDockerError } from '../src/docker.js';
import { API_IMAGES, BUILD_HELPER, CP_IMAGE } from '../src/pins.js';
import { mkRoot, fakeEnv, seedDocker, dockerCalls, FAKE_DOCKER } from './helpers.mjs';

const IMAGES = [API_IMAGES.full.ref, API_IMAGES.slim.ref, CP_IMAGE];

function make(t, { mode, sudoMode, allowSudo = true, env } = {}) {
  const r = mkRoot(t);
  seedDocker(r);
  const runDir = path.join(r.root, 'run');
  fs.mkdirSync(runDir, { mode: 0o700 });
  const docker = createDocker({ env: env ?? fakeEnv(r, { mode, sudoMode }), allowSudo: () => allowSudo, prefix: 'code-hindsight', images: IMAGES, runDir });
  return { r, docker, runDir };
}

// Spec 8: docker that works directly is used directly.
test('resolves to direct docker when the socket is usable', async (t) => {
  const { docker } = make(t);
  assert.deepEqual(await docker.resolve(), { mode: 'docker', serverVersion: '29.9.2' });
  assert.equal(docker.info().mode, 'docker');
});

// Spec 8: a refused docker falls back to `sudo -n docker` when allowed, and says so.
test('falls back to sudo -n when docker is refused and sudo is allowed', async (t) => {
  const { r, docker } = make(t, { mode: 'denied' });
  assert.equal((await docker.resolve()).mode, 'sudo');
  await docker.inspectImage(CP_IMAGE);
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /"sudo":\["-n",/);
  assert.equal(dockerCalls(r).at(-1)[0], 'image');
});

// Spec 8: with sudo disallowed, a refused docker is DOCKER_DENIED and sudo is never run.
test('refuses DOCKER_DENIED without trying sudo when sudo is not allowed', async (t) => {
  const { r, docker } = make(t, { mode: 'denied', allowSudo: false });
  await assert.rejects(docker.resolve(), (e) => e.code === 'DOCKER_DENIED' && e.params.sudoAllowed === false);
  assert.doesNotMatch(fs.readFileSync(r.logPath, 'utf8'), /"sudo"/);
});

// Spec 8: `sudo -n` that would prompt is DOCKER_DENIED carrying sudo's own message.
test('a failing sudo -n is DOCKER_DENIED with sudo\'s stderr', async (t) => {
  const { docker } = make(t, { mode: 'denied', sudoMode: 'password' });
  await assert.rejects(docker.resolve(), (e) => e.code === 'DOCKER_DENIED' && /password is required/.test(e.message));
});

test('a missing docker binary is DOCKER_NOT_FOUND; a stopped daemon is DOCKER_DAEMON_DOWN', async (t) => {
  const r = mkRoot(t);
  const missing = createDocker({ env: { ...fakeEnv(r), CODE_HINDSIGHT_DOCKER_BIN: path.join(r.root, 'nope') }, allowSudo: () => true, prefix: 'code-hindsight', images: IMAGES, runDir: r.root });
  await assert.rejects(missing.resolve(), { code: 'DOCKER_NOT_FOUND' });
  const { docker } = make(t, { mode: 'daemon-down' });
  await assert.rejects(docker.resolve(), { code: 'DOCKER_DAEMON_DOWN' });
});

test('a resolve failure is not cached: the next resolve tries again', async (t) => {
  const r = mkRoot(t);
  seedDocker(r);
  const env = fakeEnv(r, { mode: 'daemon-down' });
  const docker = createDocker({ env, allowSudo: () => true, prefix: 'code-hindsight', images: IMAGES, runDir: r.root });
  await assert.rejects(docker.resolve());
  env.FAKE_DOCKER_MODE = '';
  assert.equal((await docker.resolve()).mode, 'docker');
});

test('classifyDockerError names the failures the UI acts on', () => {
  assert.equal(classifyDockerError('Bind for 0.0.0.0:18888 failed: port is already allocated'), 'PORT_IN_USE');
  assert.equal(classifyDockerError('listen tcp 127.0.0.1:19999: bind: address already in use'), 'PORT_IN_USE');
  assert.equal(classifyDockerError("Unable to find image 'x' locally"), 'IMAGE_MISSING');
  assert.equal(classifyDockerError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'), 'DOCKER_DAEMON_DOWN');
  assert.equal(classifyDockerError('permission denied while trying to connect to the Docker daemon socket'), 'DOCKER_DENIED');
  assert.equal(classifyDockerError('something else'), 'DOCKER_FAILED');
});

// GPU5: the daemon's refusals to attach a GPU are GPU_UNAVAILABLE, so a GPU start never ends as a generic failure.
test('GPU5: classifyDockerError names a GPU the daemon cannot attach GPU_UNAVAILABLE', () => {
  assert.equal(classifyDockerError('docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].'), 'GPU_UNAVAILABLE');
  assert.equal(classifyDockerError('docker: Error response from daemon: unknown or invalid runtime name: nvidia.'), 'GPU_UNAVAILABLE');
  assert.equal(classifyDockerError('docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error running prestart hook #0: exit status 1, stdout: , stderr: Auto-detected mode as \'legacy\'\nnvidia-container-cli: initialization error: nvml error: driver not loaded: unknown'), 'GPU_UNAVAILABLE');
  assert.equal(classifyDockerError('docker: Error response from daemon: could not apply required modification to OCI specification: error modifying OCI spec: failed to inject CDI devices: unresolvable CDI devices nvidia.com/gpu=all'), 'GPU_UNAVAILABLE');
});

// Invariant (spec 4): no container, volume or network outside the prefix is ever touched.
test('the name guard refuses every resource outside the prefix', async (t) => {
  const { r, docker } = make(t);
  for (const call of [
    () => docker.inspectContainer('code-conductor-conductor-1'),
    () => docker.inspectVolume('vscode'),
    () => docker.createNetwork('bridge', {}),
    () => docker.removeContainer('code-hindsightx'),
    () => docker.removeVolume('other'),
    () => docker.stopContainers(['code-hindsight-api', 'code-conductor-conductor-1']),
    () => docker.logs('mystery'),
    () => docker.runContainer({ args: ['-d', '--name', 'evil', 'img'], env: {} }),
    () => docker.runHelper('build', BUILD_HELPER, [], () => {}),
    () => docker.stopDetached(['code-conductor-conductor-1']),
  ]) {
    await assert.rejects(async () => call(), /refusing to touch/);
  }
  assert.deepEqual(dockerCalls(r), [], 'nothing reached docker');
  assert.equal(docker.assertOwnedName('code-hindsight-api'), 'code-hindsight-api');
});

// Invariant (spec 4): only pinned images are pulled, saved or removed.
test('the image guard refuses images that are not pinned', async (t) => {
  const { docker } = make(t);
  await assert.rejects(async () => docker.pull('ubuntu:latest'), /not pinned/);
  await assert.rejects(async () => docker.removeImages(['code-conductor:local']), /not pinned/);
  await assert.rejects(async () => docker.save(['node:24'], fs.createWriteStream('/dev/null')), /not pinned/);
});

// Invariant (spec 4/5): keys reach `docker run` only through a private env file that is gone afterwards.
test('runContainer passes env through a 0600 env file, never on the command line', async (t) => {
  const { r, docker, runDir } = make(t);
  await docker.resolve();
  await docker.runContainer({ args: ['-d', '--name', 'code-hindsight-api', API_IMAGES.full.ref], env: { SECRET_KEY: 'hunter2', OTHER: 'x' } });
  const run = dockerCalls(r).find((a) => a[0] === 'run');
  assert.equal(run.includes('--env-file'), true);
  assert.equal(run.join(' ').includes('hunter2'), false, 'the key is not on argv');
  const state = JSON.parse(fs.readFileSync(r.statePath, 'utf8'));
  assert.deepEqual(state.containers['code-hindsight-api'].Config.Env, ['SECRET_KEY=hunter2', 'OTHER=x']);
  assert.deepEqual(fs.readdirSync(runDir), [], 'env file removed');
});

test('runContainer refuses a value with a line break (it would inject another variable)', async (t) => {
  const { docker } = make(t);
  await docker.resolve();
  await assert.rejects(docker.runContainer({ args: ['-d', '--name', 'code-hindsight-api', 'img'], env: { A: 'x\nB=y' } }), /line break/);
});

test('stopDetached runs `docker stop` in its own process and returns its pid', async (t) => {
  const { r, docker } = make(t);
  await docker.resolve();
  const pid = await docker.stopDetached(['code-hindsight-cp', 'code-hindsight-api'], 30);
  assert.ok(Number.isInteger(pid));
  const end = Date.now() + 5000;
  while (!dockerCalls(r).some((a) => a[0] === 'stop') && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'stop'), ['stop', '-t', '30', 'code-hindsight-cp', 'code-hindsight-api']);
  assert.ok(fs.existsSync(FAKE_DOCKER));
});
