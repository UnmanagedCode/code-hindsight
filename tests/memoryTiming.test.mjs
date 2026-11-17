// Durations and timing breakdowns in the memory activity log. The clients are stubs whose calls the
// test settles by hand against an injected clock, so every duration is exact and nothing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot } from './helpers.mjs';
import { startFakeCc, live } from './support/fakeCc.mjs';
import { startFakeHindsight, FAKE_KEY } from './support/fakeHindsight.mjs';
import { validateScopes } from '../src/scopes.js';
import { AppError } from '../src/errors.js';
import { createCcClient } from '../src/ccSession.js';
import { createHindsightClient } from '../src/hindsightClient.js';
import { createRetainCursors } from '../src/retainCursor.js';
import { createActivityLog } from '../src/activity.js';
import { createMemory } from '../src/memory.js';

const S = 's1';
const SESSION = { sessionId: S, project: 'proj', worktree: 'main', kind: 'worker', stage: 'plan', playbook: null };
const scope = (over = {}) => ({ name: 'all', match: {}, bank: 'fast', actions: ['recall', 'retain'], ...over });
const turn = (n, role = 'assistant', content = `turn ${n}`) => ({ id: `u${n}`, role, content, timestamp: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z` });
const flush = () => new Promise((r) => setImmediate(r));

/** A stubbed async function whose calls wait until the test settles them. */
function port() {
  const queue = [];
  const fn = (...args) => new Promise((resolve, reject) => queue.push({ args, resolve, reject }));
  const next = async () => {
    for (let i = 0; i < 50 && !queue.length; i++) await flush();
    assert.ok(queue.length, 'the call was made');
    return queue.shift();
  };
  return { fn, next };
}

function rig(t, scopes) {
  const r = mkRoot(t);
  const v = validateScopes(scopes);
  assert.deepEqual(v.errors, []);
  const clock = { t: 1000 };
  const ports = { session: port(), workspace: port(), recall: port(), retain: port() };
  const cc = { resolveSession: ports.session.fn, workspaceOf: ports.workspace.fn };
  const hindsight = { isReady: () => true, recall: (bank) => ports.recall.fn(bank), retain: (...a) => ports.retain.fn(...a) };
  const activity = createActivityLog({ dataDir: r.dataDir, log: () => {} });
  const cursors = createRetainCursors(r.dataDir);
  const memory = createMemory({ scopes: { get: () => v.scopes }, cc, hindsight, cursors, activity, clock: () => clock.t });
  /** Advance the clock by `ms`, then settle the call (resolve with `value`, or reject when it is an Error). */
  const settle = async (call, ms, value) => {
    clock.t += ms;
    if (value instanceof Error) call.reject(value); else call.resolve(value);
    await flush();
  };
  const entries = (pred = () => true) => activity.list().filter(pred);
  return { r, clock, ports, memory, activity, settle, entries, hindsight };
}
const wsScope = (over = {}) => scope({ name: 'ws', match: { workspaces: ['WS'] }, ...over });

test('a recall\'s summary entry spans the whole recall, and its breakdown separates the session lookup, the workspace lookup and the Hindsight fan-out', async (t) => {
  const x = rig(t, [wsScope()]);
  const done = x.memory.recallForHook(S, 'q');
  await x.settle(await x.ports.session.next(), 30, SESSION);
  await x.settle(await x.ports.workspace.next(), 20, 'WS');
  await x.settle(await x.ports.recall.next(), 400, []);
  await done;
  const [e] = x.entries((a) => a.event === 'recall' && a.outcome === 'ok');
  assert.equal(e.durationMs, 450);
  assert.deepEqual(e.timing, { totalMs: 450, sessionMs: 30, workspaceMs: 20, hindsightMs: 400, banks: [{ bank: 'fast', ms: 400 }] });
});

test('each bank\'s own time is in the breakdown, so a slow bank stands out from a fast one', async (t) => {
  const x = rig(t, [scope({ name: 'a', bank: 'fast' }), scope({ name: 'b', bank: 'slow' })]);
  const done = x.memory.recallForHook(S, 'q');
  await x.settle(await x.ports.session.next(), 10, SESSION);
  const fast = await x.ports.recall.next();
  const slow = await x.ports.recall.next();
  await x.settle(fast, 100, []);
  await x.settle(slow, 300, []);
  await done;
  const [e] = x.entries((a) => a.outcome === 'ok');
  assert.deepEqual(e.timing.banks, [{ bank: 'fast', ms: 100 }, { bank: 'slow', ms: 400 }]);
  assert.equal(e.timing.hindsightMs, 400);
  assert.equal('workspaceMs' in e.timing, false, 'no workspace lookup was needed');
});

test('a bank that hit the recall deadline is logged with its own duration, and the summary\'s breakdown marks it with its code', async (t) => {
  const x = rig(t, [scope({ name: 'a', bank: 'fast' }), scope({ name: 'b', bank: 'slow' })]);
  const done = x.memory.recallForHook(S, 'q');
  await x.settle(await x.ports.session.next(), 10, SESSION);
  const fast = await x.ports.recall.next();
  const slow = await x.ports.recall.next();
  // The failing bank settles first, so its own time (150) differs from the fan-out's (200).
  await x.settle(slow, 150, new AppError('RECALL_FAILED', { bank: 'slow', detail: 'no answer before the recall deadline' }));
  await x.settle(fast, 50, []);
  await done;
  const [bankErr] = x.entries((a) => a.code === 'RECALL_FAILED');
  assert.equal(bankErr.durationMs, 150);
  const [ok] = x.entries((a) => a.outcome === 'ok');
  assert.deepEqual(ok.timing.banks, [{ bank: 'fast', ms: 200 }, { bank: 'slow', ms: 150, code: 'RECALL_FAILED' }]);
  assert.equal(ok.timing.hindsightMs, 200);
});

test('the recall tool keeps the breakdown when every bank failed: each per-bank entry carries the whole recall\'s timing', async (t) => {
  const x = rig(t, [scope({ name: 'a', bank: 'one' }), scope({ name: 'b', bank: 'two' })]);
  const done = x.memory.recallForMcp(S, 'q').catch((e) => e);
  await x.settle(await x.ports.session.next(), 10, SESSION);
  const one = await x.ports.recall.next();
  const two = await x.ports.recall.next();
  await x.settle(one, 60, new AppError('RECALL_FAILED', { bank: 'one', detail: 'down' }));
  await x.settle(two, 40, new AppError('RECALL_FAILED', { bank: 'two', detail: 'down' }));
  assert.equal((await done).code, 'RECALL_FAILED');
  assert.equal(x.entries((a) => a.outcome === 'ok').length, 0, 'the tool writes no summary when every bank fails');
  const errs = x.entries((a) => a.code === 'RECALL_FAILED').reverse();
  assert.deepEqual(errs.map((e) => e.durationMs), [60, 100]);
  for (const e of errs) {
    assert.deepEqual(e.timing, { totalMs: 110, sessionMs: 10, hindsightMs: 100, banks: [{ bank: 'one', ms: 60, code: 'RECALL_FAILED' }, { bank: 'two', ms: 100, code: 'RECALL_FAILED' }] });
  }
});

test('a session lookup that fails, times out or finds the session not live logs the lookup\'s duration, on recall, the tool and retain', async (t) => {
  const failures = [
    [new AppError('SESSION_UNRESOLVED', { detail: 'cc did not answer in time' }), 'SESSION_UNRESOLVED', 'error'],
    [new AppError('SESSION_NOT_LIVE', { sessionId: S }), 'SESSION_NOT_LIVE', 'skipped'],
  ];
  for (const [err, code, outcome] of failures) {
    const calls = [
      ['recall', (m) => m.recallForHook(S, 'q')],
      ['mcp-recall', (m) => m.recallForMcp(S, 'q').catch(() => {})],
      ['retain', (m) => m.retainForHook(S, [turn(1, 'user'), turn(2)])],
    ];
    for (const [event, run] of calls) {
      const x = rig(t, [scope()]);
      const done = run(x.memory);
      await x.settle(await x.ports.session.next(), 40, err);
      await done;
      const [e] = x.entries((a) => a.event === event);
      assert.equal(e.code, code, event);
      assert.equal(e.outcome, outcome, event);
      assert.equal(e.durationMs, 40, event);
      assert.deepEqual(e.timing, { totalMs: 40, sessionMs: 40 }, event);
    }
  }
});

test('a workspace lookup that was cut off is logged WORKSPACE_UNRESOLVED with the lookup\'s duration', async (t) => {
  const x = rig(t, [wsScope()]);
  const done = x.memory.recallForHook(S, 'q');
  await x.settle(await x.ports.session.next(), 15, SESSION);
  await x.settle(await x.ports.workspace.next(), 25, new AppError('WORKSPACE_UNRESOLVED', { detail: 'cc did not answer in time' }));
  await done;
  const [e] = x.entries((a) => a.code === 'WORKSPACE_UNRESOLVED');
  assert.equal(e.durationMs, 25);
  assert.deepEqual(e.timing, { totalMs: 40, sessionMs: 15, workspaceMs: 25 });
});

test('a retain\'s ok entry spans the Stop to Hindsight\'s acknowledgement, with the Stop\'s lookups, the hook\'s answer and the send apart', async (t) => {
  const x = rig(t, [wsScope()]);
  const stop = x.memory.retainForHook(S, [turn(1, 'user'), turn(2)]);
  await x.settle(await x.ports.session.next(), 10, SESSION);
  await x.settle(await x.ports.workspace.next(), 5, 'WS');
  assert.deepEqual(await stop, { status: 'accepted' });
  await x.settle(await x.ports.retain.next(), 200, {});
  await x.memory.idle();
  const [e] = x.entries((a) => a.event === 'retain' && a.outcome === 'ok');
  assert.equal(e.durationMs, 215);
  assert.deepEqual(e.timing, { totalMs: 215, acceptMs: 15, sessionMs: 10, workspaceMs: 5, hindsightMs: 200 });
});

test('a failed retain send logs the send\'s duration; its later resend carries only the send time', async (t) => {
  const x = rig(t, [scope()]);
  const stop = x.memory.retainForHook(S, [turn(1, 'user'), turn(2)]);
  await x.settle(await x.ports.session.next(), 10, SESSION);
  await stop;
  await x.settle(await x.ports.retain.next(), 70, new AppError('RETAIN_FAILED', { bank: 'fast', detail: 'down' }));
  await x.memory.idle();
  const [failed] = x.entries((a) => a.code === 'RETAIN_FAILED');
  assert.equal(failed.durationMs, 70);
  assert.deepEqual(failed.timing, { totalMs: 80, acceptMs: 10, sessionMs: 10, hindsightMs: 70 });

  const again = x.memory.retainForHook(S, [turn(1, 'user'), turn(2), turn(3, 'user'), turn(4)]);
  await x.settle(await x.ports.session.next(), 5, SESSION);
  await again;
  await x.settle(await x.ports.retain.next(), 30, {});
  await x.settle(await x.ports.retain.next(), 1, {});
  await x.memory.idle();
  const resent = x.entries((a) => a.message === 'resent an unacknowledged batch');
  assert.equal(resent.length, 1);
  assert.equal(resent[0].durationMs, 30);
  assert.deepEqual(resent[0].timing, { hindsightMs: 30 });
});

test('entries with no measured step carry no duration (BANK_RENDER_FAILED, RETAIN_STALE)', async (t) => {
  const x = rig(t, [scope({ bank: '{project}' })]);
  const stage = { ...SESSION, project: '!!!' };
  const done = x.memory.recallForHook(S, 'q');
  await x.settle(await x.ports.session.next(), 10, stage);
  await done;
  const [render] = x.entries((a) => a.code === 'BANK_RENDER_FAILED');
  assert.ok(render, 'the scope\'s bank did not render');
  assert.equal(render.durationMs, undefined);
  assert.equal(render.timing, undefined);

  const y = rig(t, [scope()]);
  const bare = (n, role) => ({ id: `b${n}`, role, content: `c${n}`, timestamp: null });
  const A = [bare(1, 'user'), bare(2, 'assistant')];
  const B = [...A, bare(3, 'user'), bare(4, 'assistant')];
  const C = [...A, bare(3, 'user')];
  for (const turns of [A, B, C]) {
    const stop = y.memory.retainForHook(S, turns);
    await y.settle(await y.ports.session.next(), 1, SESSION);
    await stop;
  }
  await y.settle(await y.ports.retain.next(), 1, {});
  await y.settle(await y.ports.retain.next(), 1, {});
  await y.memory.idle();
  const [stale] = y.entries((a) => a.code === 'RETAIN_STALE');
  assert.ok(stale, 'the late Stop was reported stale');
  assert.equal(stale.durationMs, undefined);
  assert.equal(stale.timing, undefined);
});

test('the activity store keeps durationMs and timing, and still lists log lines written without them', async (t) => {
  const r = mkRoot(t);
  const file = path.join(r.dataDir, 'logs', 'memory.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: 'recall', outcome: 'ok', count: 1 })}\n`);
  const log = createActivityLog({ dataDir: r.dataDir, log: () => {} });
  const timing = { totalMs: 5, banks: [{ bank: 'b', ms: 3, code: 'RECALL_FAILED' }] };
  log.add({ event: 'recall', outcome: 'ok', durationMs: 5, timing });
  const [newest, older] = createActivityLog({ dataDir: r.dataDir, log: () => {} }).list();
  assert.equal(newest.durationMs, 5);
  assert.deepEqual(newest.timing, timing);
  assert.equal(older.count, 1);
  assert.equal(older.durationMs, undefined);
});

test('with the default clock, a real recall and retain over the fake cc and Hindsight log non-negative integer durations', async (t) => {
  const r = mkRoot(t);
  const cc = await startFakeCc(t);
  const hs = await startFakeHindsight(t);
  cc.session(S, live());
  const v = validateScopes([scope({ bank: 'cc-{project}' })]);
  const activity = createActivityLog({ dataDir: r.dataDir, log: () => {} });
  const memory = createMemory({
    scopes: { get: () => v.scopes },
    cc: createCcClient({ conductorUrl: cc.url }),
    hindsight: createHindsightClient({ connection: () => ({ apiUrl: hs.url, apiKey: FAKE_KEY }) }),
    cursors: createRetainCursors(r.dataDir),
    activity,
  });
  await memory.recallForHook(S, 'hello');
  await memory.retainForHook(S, [turn(1, 'user'), turn(2)]);
  await memory.idle();
  const timed = activity.list().filter((e) => e.event === 'recall' || e.event === 'retain');
  assert.equal(timed.filter((e) => e.outcome === 'ok').length, 2);
  for (const e of timed) {
    assert.ok(Number.isInteger(e.durationMs) && e.durationMs >= 0, `${e.event} ${e.code ?? e.outcome}`);
    assert.ok(Number.isInteger(e.timing.totalMs ?? e.timing.hindsightMs));
  }
});
