// jobs.js over the fake docker: each explicit action's docker arguments, one job at a time,
// streamed import, bundle export, and the confirmations destructive actions need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createDocker } from '../src/docker.js';
import { createJobs, buildCpArgs, bundleName } from '../src/jobs.js';
import { resourceNames, ownerId } from '../src/containerSpec.js';
import { API_IMAGES, BUILD_HELPER_IMAGE, CP_IMAGE, LABELS, BASE_PATH } from '../src/pins.js';
import { mkRoot, fakeEnv, seedDocker, dockerCalls, dockerState, goodApiImage, goodCpImage } from './helpers.mjs';

const names = resourceNames('code-hindsight');

function make(t, { seed, mode } = {}) {
  const r = mkRoot(t);
  seedDocker(r, seed);
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  const docker = createDocker({ env: fakeEnv(r, { mode }), allowSudo: () => true, prefix: 'code-hindsight', images: [API_IMAGES.full.ref, API_IMAGES.slim.ref, CP_IMAGE, BUILD_HELPER_IMAGE], runDir: r.dataDir });
  const after = [];
  const supervisor = { afterPrecondition: async () => { after.push(1); } };
  const owner = ownerId(r.dataDir);
  const jobs = createJobs({ docker, supervisor, names, owner, dataDir: r.dataDir });
  return { r, docker, jobs, after, owner };
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

// Spec 6: the CP image is built from the upstream tag with our base path, in the pinned helper.
test('build-cp runs buildx in the pinned helper: git context at the tag, cp-only, our base path and labels', async (t) => {
  const { r, jobs } = make(t, { seed: { images: { [API_IMAGES.full.ref]: goodApiImage() }, registry: { [CP_IMAGE]: goodCpImage() } } });
  const end = await jobs.start('build-cp').done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  const run = dockerCalls(r).find((a) => a[0] === 'run');
  assert.deepEqual(run.slice(0, 4), ['run', '--rm', '--name', 'code-hindsight-build']);
  assert.deepEqual(run.slice(4), buildCpArgs());
  const args = buildCpArgs();
  assert.equal(args[args.indexOf('-v') + 1], '/var/run/docker.sock:/var/run/docker.sock');
  assert.equal(args[2], BUILD_HELPER_IMAGE);
  assert.ok(args.includes('https://github.com/vectorize-io/hindsight.git#v1.2.1'));
  assert.equal(args[args.indexOf('--target') + 1], 'cp-only');
  assert.equal(args[args.indexOf('-f') + 1], 'docker/standalone/Dockerfile');
  assert.equal(args[args.indexOf('--build-arg') + 1], `NEXT_PUBLIC_BASE_PATH=${BASE_PATH}`);
  assert.ok(args.includes(`${LABELS.basePath}=${BASE_PATH}`) && args.includes(`${LABELS.upstream}=v1.2.1`));
  assert.equal(args[args.indexOf('-t') + 1], CP_IMAGE);
  assert.ok(dockerState(r).images[CP_IMAGE]);
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
  const bundle = JSON.stringify({ images: { [API_IMAGES.full.ref]: goodApiImage(), [CP_IMAGE]: goodCpImage() } });
  const end = await jobs.start('import', { stdin: Readable.from([Buffer.from(bundle.slice(0, 10)), Buffer.from(bundle.slice(10))]) }).done;
  assert.equal(end.state, 'done', JSON.stringify(end.error));
  assert.deepEqual(end.result.loaded, [API_IMAGES.full.ref, CP_IMAGE]);
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'load'), ['load']);
});

test('import from a host path validates the path, then loads the file', async (t) => {
  const { jobs, r } = make(t, { seed: { images: {} } });
  assert.throws(() => jobs.start('import', { path: 'relative.tar' }), { code: 'IMPORT_PATH_INVALID' });
  assert.throws(() => jobs.start('import', { path: path.join(r.root, 'missing.tar') }), (e) => e.code === 'IMPORT_PATH_INVALID' && /no such file/.test(e.message));
  assert.throws(() => jobs.start('import', { path: r.root }), (e) => /not a regular file/.test(e.message));
  const file = path.join(r.root, 'bundle.tar');
  fs.writeFileSync(file, JSON.stringify({ images: { [API_IMAGES.slim.ref]: goodApiImage('slim') } }));
  const end = await jobs.start('import', { path: file }).done;
  assert.deepEqual(end.result.loaded, [API_IMAGES.slim.ref]);
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
  assert.deepEqual(Object.keys(dockerState(r).images), ['node:24'], 'an unpinned image stays');
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
