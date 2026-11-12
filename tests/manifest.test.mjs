// conductor.plugin.json: the id, the backend start and the health path the backend serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, boot } from './helpers.mjs';
import { BASE_PATH } from '../src/pins.js';

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'conductor.plugin.json'), 'utf8'));

test('the manifest id is the one the CP image is built for; the frontend sits at the root', () => {
  assert.equal(manifest.id, 'code-hindsight');
  assert.equal(`/plugins/${manifest.id}`, BASE_PATH);
  assert.equal(manifest.pluginApi, 1);
  assert.equal(manifest.backend.start, 'node server.js');
  assert.deepEqual(manifest.frontend, { path: '/', navLabel: 'Code Hindsight' });
  assert.equal(manifest.name, 'Code Hindsight');
});

test('the manifest healthPath answers 200 even when Docker is unusable', async (t) => {
  const { url } = await boot(t, { mode: 'daemon-down' });
  assert.equal((await fetch(url + manifest.backend.healthPath)).status, 200);
});
