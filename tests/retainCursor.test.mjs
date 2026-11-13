// retainCursor.js: the persisted cursor store (pruning, hostile keys, shape validation) and the
// placement of windows of unsent turns in a transcript tail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot, fakeClock } from './helpers.mjs';
import { createRetainCursors, CURSOR_MAX_AGE_MS, windowTurns, lastExchangeBoundary, endsAfter, isValidCursor } from '../src/retainCursor.js';

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

const T = (n, over = {}) => ({ id: `u${n}`, role: 'assistant', content: `c${n}`, timestamp: `2026-01-01T00:00:0${n}.000Z`, ...over });
const B = (n) => ({ lastId: `u${n}`, lastTs: `2026-01-01T00:00:0${n}.000Z` });
const ids = (turns) => turns?.map((t) => t.id);

test('windowTurns: boundaries found by id give the turns strictly after `from` up to and including `to`', () => {
  const tail = [T(1), T(2), T(3), T(4)];
  assert.deepEqual(ids(windowTurns(tail, B(1), B(3))), ['u2', 'u3']);
  assert.deepEqual(ids(windowTurns(tail, { lastId: null, lastTs: null }, B(2))), ['u1', 'u2'], 'a null boundary is the start of the tail');
});

test('windowTurns: a missing boundary id falls back to timestamps (a newer tail after a rotation)', () => {
  const tail = [T(5), T(6)];
  assert.deepEqual(ids(windowTurns(tail, B(4), B(6))), ['u5', 'u6']);
  const copied = [{ ...T(1), id: 'n1' }, { ...T(2), id: 'n2' }, T(7), T(8)];
  assert.deepEqual(ids(windowTurns(copied, B(2), B(8))), ['u7', 'u8'], 'a copied transcript with new ids');
});

test('windowTurns: a partial tail yields what it still holds', () => {
  assert.deepEqual(ids(windowTurns([T(2), T(3), T(4)], B(2), B(4))), ['u3', 'u4']);
  assert.deepEqual(ids(windowTurns([T(3), T(4)], B(1), B(4))), ['u3', 'u4'], 'the trimmed part is gone, the rest is sent');
});

test('windowTurns: a turn at the boundary\'s own millisecond is the boundary turn, not a new one', () => {
  const ms = '2026-01-01T00:00:01.000Z';
  const tail = [{ id: 'a', role: 'user', content: '', timestamp: ms }, { id: 'b', role: 'assistant', content: '', timestamp: ms }, T(2)];
  assert.deepEqual(ids(windowTurns(tail, { lastId: 'gone', lastTs: ms }, B(2))), ['u2']);
});

test('windowTurns: a window that cannot be placed is null, never an empty list', () => {
  assert.equal(windowTurns([T(5), T(6)], B(2), B(4)), null, 'the window\'s turns left the tail, which holds only newer ones');
  assert.equal(windowTurns([T(1), T(2)], B(3), B(4)), null, 'the tail is older than the window');
  const bare = (n) => ({ id: `b${n}`, role: 'user', content: '', timestamp: null });
  assert.equal(windowTurns([bare(1), bare(2)], B(2), B(4)), null, 'no timestamps to place a missing boundary');
  assert.equal(windowTurns([T(1), T(2)], B(1), B(1)), null, 'an empty window is a loss too: recorded windows are never empty');
});

test('lastExchangeBoundary starts just before the last user turn, and is undefined without one', () => {
  const tail = [T(1, { role: 'user' }), T(2), T(3, { role: 'user' }), T(4)];
  assert.deepEqual(lastExchangeBoundary(tail), B(2));
  assert.deepEqual(lastExchangeBoundary([T(1, { role: 'user' }), T(2)]), { lastId: null, lastTs: null });
  assert.equal(lastExchangeBoundary([T(1), T(2)]), undefined);
});

test('endsAfter: a tail is newer only if it ends after the previous end, by id or (after a rotation) by time', () => {
  const tail = [T(1), T(2), T(3)];
  assert.equal(endsAfter(tail, B(2)), true);
  assert.equal(endsAfter(tail, B(3)), false, 'the previous end is already the last turn');
  assert.equal(endsAfter([T(1), T(2)], B(3)), false, 'an older tail arriving late: stale');
  assert.equal(endsAfter([T(5), T(6)], B(3)), true, 'a rotated tail that is newer');
  assert.equal(endsAfter([T(5), T(6)], { lastId: 'x', lastTs: null }), true, 'no time to compare: not provably stale');
  assert.equal(endsAfter([], B(1)), false);
});

test('isValidCursor accepts what the writer produces and refuses wrong shapes, so they are never spread or sent', () => {
  const win = { bank: 'b', session: { project: 'p', worktree: 'w', kind: 'worker', stage: null }, lastId: 'u1', lastTs: null };
  const ok = { lastId: 'u0', lastTs: null, pending: [win, { ...win, bank: null }] };
  assert.equal(isValidCursor(ok), true);
  assert.equal(isValidCursor({ ...ok, pending: 'abc' }), false);
  assert.equal(isValidCursor({ ...ok, pending: [{ ...win, lastId: 5 }] }), false);
  assert.equal(isValidCursor({ ...ok, pending: [{ ...win, bank: '../x' }] }), false);
  assert.equal(isValidCursor({ ...ok, inflight: { bank: 'b' } }), false);
  assert.equal(isValidCursor({ ...ok, lastId: 3 }), false);
  assert.equal(isValidCursor('nope'), false);
  assert.equal(isValidCursor({ lastId: null, lastTs: null }), false, 'pending is required');
});

test('drop forgets one entry on disk; a cursors.json that is not an object is refused, not spread', (t) => {
  const r = mkRoot(t);
  const cursors = createRetainCursors(r.dataDir);
  cursors.set('a', { lastId: 'x', lastTs: null, pending: [] });
  cursors.set('b', { lastId: 'y', lastTs: null, pending: [] });
  cursors.drop('a');
  const again = createRetainCursors(r.dataDir);
  assert.deepEqual([again.get('a'), again.get('b')?.lastId], [undefined, 'y']);
  fs.writeFileSync(path.join(r.dataDir, 'memory', 'cursors.json'), '"abc"');
  assert.throws(() => createRetainCursors(r.dataDir).get('0'), /not an object/);
});
