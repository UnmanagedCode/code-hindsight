// retainCursor.js: the persisted cursor store (pruning, hostile keys) and which turns are new.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot, fakeClock } from './helpers.mjs';
import { createRetainCursors, CURSOR_MAX_AGE_MS } from '../src/retainCursor.js';

test('an entry older than the maximum age is pruned on the next write; the writer\'s own entry survives', (t) => {
  const r = mkRoot(t);
  const clock = fakeClock();
  const cursors = createRetainCursors(r.dataDir, { now: clock.now });
  cursors.set('old', { lastId: 'a', lastTs: null });
  clock.advance(CURSOR_MAX_AGE_MS - 1000);
  cursors.set('recent', { lastId: 'b', lastTs: null });
  assert.ok(cursors.get('old'), 'not yet expired');
  clock.advance(2000);
  cursors.set('fresh', { lastId: 'c', lastTs: null });
  assert.equal(cursors.get('old'), undefined);
  assert.ok(cursors.get('recent'), 'younger than the maximum age');
  assert.ok(cursors.get('fresh'));
  const reread = createRetainCursors(r.dataDir, { now: clock.now });
  assert.deepEqual([reread.get('old'), !!reread.get('fresh')], [undefined, true], 'the pruning is what was written');
});

test('session ids that name Object.prototype members are ordinary keys, and nothing is polluted', (t) => {
  const r = mkRoot(t);
  const cursors = createRetainCursors(r.dataDir);
  assert.equal(cursors.get('__proto__'), undefined);
  assert.equal(cursors.get('constructor'), undefined);
  cursors.set('__proto__', { lastId: 'x', lastTs: null });
  assert.equal(cursors.get('__proto__').lastId, 'x');
  assert.equal(cursors.get('constructor'), undefined);
  assert.equal({}.lastId, undefined);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(r.dataDir, 'memory', 'cursors.json'), 'utf8')), '__proto__'), true);
  const reread = createRetainCursors(r.dataDir);
  assert.equal(reread.get('__proto__').lastId, 'x');
  reread.set('other', { lastId: 'y', lastTs: null });
  assert.equal({}.lastId, undefined);
});
