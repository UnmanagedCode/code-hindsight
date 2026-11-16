// Directive: images are pinned by tag, never by digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_IMAGES, CP_IMAGE, BUILD_HELPER } from '../src/pins.js';

test('Directive: every image reference is a tag, none a digest', () => {
  const refs = [...Object.values(API_IMAGES).map((v) => v.ref), CP_IMAGE, BUILD_HELPER];
  for (const ref of refs) {
    assert.equal(typeof ref, 'string');
    assert.doesNotMatch(ref, /@sha256:/);
  }
  for (const v of Object.values(API_IMAGES)) assert.ok(!('ids' in v), 'no pinned image IDs');
});
