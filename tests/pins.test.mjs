// Directive: pin tags, not hashes. Images are pinned by tag (never a digest), upstream's source by
// its git release tag (never a commit), torch by version (never a wheel hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pins from '../src/pins.js';
import { buildCpCommand, buildGpuCommand } from '../src/jobs.js';
import { GPU_RECIPE } from '../src/gpuRecipe.js';

const { API_IMAGES, API_GPU_IMAGE, CP_IMAGE, BUILD_HELPER, HINDSIGHT_VERSION, UPSTREAM_TAG, UPSTREAM_REPO } = pins;
/** A commit/digest-length hex run, or anything naming sha256. */
const HASH = /\b[0-9a-f]{40,64}\b|sha256/i;
/** Every string in a value, however nested. */
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

test('Directive: every image reference is a tag, none a digest', () => {
  const refs = [...Object.values(API_IMAGES).map((v) => v.ref), API_GPU_IMAGE, CP_IMAGE, BUILD_HELPER];
  for (const ref of refs) {
    assert.equal(typeof ref, 'string');
    assert.match(ref, /:[\w.-]+$/, `${ref} names a tag`);
    assert.doesNotMatch(ref, /@sha256:/);
  }
  for (const v of Object.values(API_IMAGES)) assert.ok(!('ids' in v), 'no pinned image IDs');
});

test('Directive: no pin in src/pins.js is a hash; upstream is pinned by its release tag', () => {
  for (const s of strings({ ...pins })) assert.doesNotMatch(s, HASH, `pin ${s}`);
  assert.equal(UPSTREAM_TAG, `v${HINDSIGHT_VERSION}`);
  assert.equal('UPSTREAM_REVISION' in pins, false, 'no commit pin');
});

test('Directive: the CP and GPU builds name tags only (CP source at the release tag; GPU recipe FROM a tag, torch by version)', () => {
  const cp = buildCpCommand();
  assert.ok(cp.includes(`${UPSTREAM_REPO}#${UPSTREAM_TAG}`), 'the CP builds from the release tag');
  for (const cmd of [cp, buildGpuCommand()]) for (const a of cmd) assert.doesNotMatch(a, HASH, `build argument ${a}`);
  assert.doesNotMatch(GPU_RECIPE, HASH, 'the GPU recipe names no digest, commit or wheel hash');
  assert.doesNotMatch(GPU_RECIPE, /--hash|--require-hashes/);
  for (const from of GPU_RECIPE.match(/^FROM .+$/gm)) assert.doesNotMatch(from, /@/, 'FROM a tag');
});
