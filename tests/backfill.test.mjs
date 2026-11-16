// backfill.js over the fake cc, the fake Hindsight and synthetic transcripts in a temp Claude config
// dir, driven through the real job runner: placement through cc's record only, scope matching, the
// placement cache, live-memory overlap, the dry run and its estimate, idempotent imports, and the
// activity entries. Each test names the acceptance item (A2–A6) and the invariant it pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot, boot, waitFor } from './helpers.mjs';
import { startFakeCc, live } from './support/fakeCc.mjs';
import { startFakeHindsight, FAKE_KEY } from './support/fakeHindsight.mjs';
import { claudeDir, writeTranscript, exchanges, userLine, assistantLine, at } from './support/transcripts.mjs';
import { readTranscriptFile } from '../claude/hooks/transcript.mjs';
import { renderTurn } from '../src/retainItem.js';
import { createScopesStore, validateScopes } from '../src/scopes.js';
import { createCcClient } from '../src/ccSession.js';
import { createHindsightClient } from '../src/hindsightClient.js';
import { createRetainCursors, operationIdFor } from '../src/retainCursor.js';
import { createActivityLog } from '../src/activity.js';
import { createMemory } from '../src/memory.js';
import { createJobs } from '../src/jobs.js';
import { resourceNames, ownerId } from '../src/containerSpec.js';
import { createPlacementCache } from '../src/backfillPlacements.js';
import { createBackfill, BACKFILL_LIMITS, BACKFILL_ESTIMATE, backfillDocumentId, estimateDocument, contentHash } from '../src/backfill.js';

const DIR = '-x-proj';
const H = (n) => `h-${n}`;
const B = (n) => `b-${n}`;
const KEY = (n, b = B(n)) => `${H(n)}:${b}`;
const scope = (over = {}) => ({ name: 'all', match: {}, bank: 'cc-{project}', actions: ['retain'], ...over });
const lines = (text) => text.split('\n').map((l) => JSON.parse(l));
const NONE = { sent: 0, replaced: 0, alreadyImported: 0, queued: 0, retried: 0, deleted: 0 };
/** The operation id the importer derives for a one-part session read from `file`. */
async function onePartOp(file, n) {
  const { turns } = await readTranscriptFile(file);
  const doc = backfillDocumentId(H(n), B(n), 1);
  return operationIdFor('cc-proj', doc, turns[0].id, turns.at(-1).id, contentHash(turns.map(renderTurn).join('\n')));
}

async function setup(t, { scopes = [scope()], limits = BACKFILL_LIMITS, llmMode = 'manual' } = {}) {
  const r = mkRoot(t);
  const cc = await startFakeCc(t);
  const hs = await startFakeHindsight(t);
  const store = createScopesStore(r.dataDir);
  const x = { r, cc, hs, state: { ready: true }, llm: { mode: llmMode, model: llmMode === 'none' ? null : 'model-x' } };
  x.save = (list) => { const v = validateScopes(list); assert.deepEqual(v.errors, []); store.save(v.scopes); };
  x.save(scopes);
  x.activity = createActivityLog({ dataDir: r.dataDir, log: () => {} });
  x.hindsight = createHindsightClient({ connection: () => (x.state.ready ? { apiUrl: hs.url, apiKey: FAKE_KEY } : null) });
  x.ccClient = createCcClient({ conductorUrl: cc.url });
  x.cursors = createRetainCursors(r.dataDir);
  /** Every cursor-store call the importer makes (only `peek` is allowed). */
  x.cursorCalls = [];
  const watched = new Proxy(x.cursors, { get: (o, k) => { x.cursorCalls.push(k); return o[k]; } });
  x.projects = claudeDir(r.root).projects;
  x.placements = createPlacementCache(r.dataDir);
  x.backfill = createBackfill({
    scopes: store, cc: x.ccClient, hindsight: x.hindsight, cursors: watched, activity: x.activity,
    settings: { get: () => ({ llm: x.llm }) }, placements: x.placements, transcriptsRoot: x.projects, limits,
  });
  const docker = { resolve: async () => { throw new Error('a backfill job must not resolve docker'); } };
  const supervisor = { afterPrecondition: async () => { throw new Error('no start'); }, refresh: async () => { throw new Error('no refresh'); } };
  x.jobs = createJobs({ docker, supervisor, names: resourceNames('code-hindsight'), owner: ownerId(r.dataDir), dataDir: r.dataDir, kinds: x.backfill.kinds });
  x.scan = (p = {}) => x.jobs.start('backfill-scan', p).done;
  x.import = (keys, extra = {}) => x.jobs.start('backfill-import', { scanId: x.backfill.latestScan().scanId, sessions: keys, confirm: true, ...extra }).done;
  /** A retired session `n` with one segment of `body` lines (default: two exchanges). */
  x.place = (n, { body, backing = B(n), dir = DIR, ...retired } = {}) => {
    x.cc.segment(backing, H(n));
    x.cc.retired(H(n), { worktree: 'wt', ...retired });
    return writeTranscript(x.projects, dir, backing, body ?? exchanges(2, { prefix: `${backing}-` }));
  };
  x.row = (key) => x.backfill.latestScan().sessions.find((s) => s.key === key);
  x.skip = (backingId) => x.backfill.latestScan().skipped.find((s) => s.backingId === backingId);
  return x;
}
const ok = (end) => { assert.equal(end.state, 'done', JSON.stringify(end.error)); return end.result; };
const retainedDocs = (hs) => hs.retains().flatMap((r) => r.body.items.map((i) => ({ bank: r.bank, ...i, operationId: r.body.operation_id })));

// --- A2: placement through cc's record, never by guessing ---

// A2 / invariant: a file name is a backing id; the handle cc names for it decides project, worktree and last stage.
test('scan sessions are listed newest-modified first; equal modification times keep transcript path order', async (t) => {
  const x = await setup(t);
  const T = new Date('2026-02-01T00:00:00.000Z').getTime();
  const at = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms));
  const H2 = 2 * 3600e3;
  const f1 = x.place(1);
  const f2 = x.place(2);
  const f3 = x.place(3);
  at(f1, T); at(f2, T + H2); at(f3, T);
  ok(await x.scan());
  assert.deepEqual(x.backfill.latestScan().sessions.map((s) => s.key), [KEY(2), KEY(1), KEY(3)]);
  assert.equal(x.row(KEY(2)).modifiedAt, new Date(T + H2).toISOString());

  at(f1, T + 3 * 3600e3);
  ok(await x.scan());
  assert.equal(x.backfill.latestScan().sessions[0].key, KEY(1), 'a changed file moves up on the next scan');
});

test('a transcript is placed through the handle cc names for its backing id, with that session\'s project, worktree and last stage', async (t) => {
  const x = await setup(t);
  x.place(1, { project: 'proj', worktree: 'feature', stage: 'review', title: 'Fix the parser' });
  x.place(2, { project: '.conduct', worktree: null, stage: null });
  ok(await x.scan());
  assert.deepEqual(x.cc.describedIds(), [B(1), H(1), B(2), H(2)]);
  const row = x.row(KEY(1));
  assert.deepEqual(
    [row.handle, row.backingId, row.project, row.worktree, row.kind, row.stage, row.title, row.bank, row.scope, row.status],
    [H(1), B(1), 'proj', 'feature', 'worker', 'review', 'Fix the parser', 'cc-proj', 'all', 'ready'],
  );
  assert.deepEqual([x.row(KEY(2)).kind, x.row(KEY(2)).worktree, x.row(KEY(2)).stage, x.row(KEY(2)).bank], ['conductor', 'main', null, 'cc-conduct']);
  assert.deepEqual([row.turns, row.firstAt, row.lastAt, row.documents], [4, at(0), at(3), 1]);
});

// A2 / invariant: one describe_session(handle) per handle per scan, however many segments it owns.
test('two segments of one handle are described by handle once per scan', async (t) => {
  const x = await setup(t);
  x.place(1, { backing: 'b-1a' });
  x.place(1, { backing: 'b-1b', body: exchanges(1, { prefix: 'second-', fromSec: 100 }) });
  ok(await x.scan());
  assert.equal(x.cc.describedIds().filter((id) => id === H(1)).length, 1);
  assert.deepEqual(x.backfill.latestScan().sessions.map((s) => s.key).sort(), [KEY(1, 'b-1a'), KEY(1, 'b-1b')]);
});

// A2 / invariant: what cc cannot place is reported with cc's reason and never sent anywhere.
test('unlocatable and unknown transcripts are skipped BACKFILL_UNPLACEABLE with cc\'s reason and never retained', async (t) => {
  const x = await setup(t);
  x.cc.unlocatable('b-tmp');
  writeTranscript(x.projects, '-tmp-x', 'b-tmp', exchanges(1));
  writeTranscript(x.projects, '-gone', 'b-unknown', exchanges(1));
  x.place(1);
  ok(await x.scan());
  assert.equal(x.skip('b-tmp').code, 'BACKFILL_UNPLACEABLE');
  assert.match(x.skip('b-tmp').message, /SESSION_UNLOCATABLE/);
  assert.match(x.skip('b-unknown').message, /SESSION_UNKNOWN/);
  assert.equal(x.skip('b-tmp').handle, null);
  assert.throws(() => x.jobs.start('backfill-import', { scanId: x.backfill.latestScan().scanId, sessions: ['b-tmp'], confirm: true }), { code: 'BAD_REQUEST' });
  ok(await x.import([KEY(1)]));
  assert.deepEqual(retainedDocs(x.hs).map((d) => d.document_id), [backfillDocumentId(H(1), B(1), 1)], 'only the placed session reached any bank');
});

// A2 / invariant: no scope → no bank; there is no default bank.
test('a session no retain scope matches is skipped NO_RETAIN_SCOPE, never sent to a default bank', async (t) => {
  const x = await setup(t, { scopes: [scope({ match: { projects: ['other'] } }), scope({ name: 'recall-only', actions: ['recall'] })] });
  x.place(1);
  ok(await x.scan());
  assert.equal(x.skip(B(1)).code, 'NO_RETAIN_SCOPE');
  assert.deepEqual(x.backfill.latestScan().sessions, []);
});

// A2 / invariant: an undecided first retain scope leaves the session unimported, never a later scope's bank.
test('an undecided workspace skips the session WORKSPACE_UNRESOLVED instead of falling through to a later scope', async (t) => {
  const x = await setup(t, { scopes: [scope({ name: 'ws', match: { workspaces: ['WS'] }, bank: 'ws-{project}' }), scope({ name: 'fallback', bank: 'fallback' })] });
  x.cc.failProjects(500);
  x.place(1);
  ok(await x.scan());
  assert.equal(x.skip(B(1)).code, 'WORKSPACE_UNRESOLVED');
  assert.deepEqual(x.backfill.latestScan().sessions, []);
  x.cc.failProjects(null);
  ok(await x.scan());
  assert.equal(x.row(KEY(1)).bank, 'ws-proj', 'resolved, the workspace scope wins');
});

// A2 / invariant: the last recorded stage picks the stage scope, as live retain would at that stage.
test('the stage recorded for a retired session selects the stage scope\'s bank', async (t) => {
  const x = await setup(t, { scopes: [scope({ name: 'p', match: { stages: ['plan'] }, bank: 'plan-{project}' }), scope({ name: 'r', match: { stages: ['review'] }, bank: 'review-{project}' })] });
  x.place(1, { stage: 'review' });
  x.place(2, { stage: 'plan' });
  x.place(3, { stage: null });
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).bank, x.row(KEY(1)).scope, x.row(KEY(2)).bank], ['review-proj', 'r', 'plan-proj']);
  assert.equal(x.skip(B(3)).code, 'NO_RETAIN_SCOPE', 'a session without a stage matches no stages list');
});

// A2 / invariant: a running session is never imported, and its skip is not cached.
test('a live session is skipped SESSION_LIVE and resolved again on the next scan', async (t) => {
  const x = await setup(t);
  x.cc.segment(B(1), H(1));
  x.cc.session(H(1), live());
  writeTranscript(x.projects, DIR, B(1), exchanges(1));
  ok(await x.scan());
  assert.deepEqual([x.skip(B(1)).code, x.skip(B(1)).handle], ['SESSION_LIVE', H(1)]);
  x.cc.retired(H(1));
  ok(await x.scan());
  assert.equal(x.row(KEY(1)).status, 'ready');
  assert.equal(x.cc.describedIds().filter((id) => id === B(1)).length, 2, 'resolved again, not served from the cache');
});

// A2 / eligibility ruling: any session cc places, including a plain `claude` run whose handle is its full UUID.
test('a plain claude session cc places by its full UUID is imported as a worker', async (t) => {
  const x = await setup(t);
  const uuid = '0f0e0d0c-1111-4222-8333-444455556666';
  x.cc.retired(uuid, { project: 'proj', worktree: null, stage: null, playbook: null });
  writeTranscript(x.projects, DIR, uuid, exchanges(1));
  ok(await x.scan());
  const row = x.row(`${uuid}:${uuid}`);
  assert.deepEqual([row.handle, row.kind, row.worktree, row.bank], [uuid, 'worker', 'main', 'cc-proj']);
  assert.deepEqual(x.cc.describedIds(), [uuid], 'the row answered for the file id is used directly');
  ok(await x.import([row.key]));
  assert.equal(retainedDocs(x.hs)[0].metadata.ccSessionId, uuid);
});

// A2 / invariant: a cc failure is never remembered as a placement, and a cc that keeps failing stops the scan.
test('cc timeouts are not cached; consecutive cc failures abort the scan BACKFILL_CC_UNAVAILABLE', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, describeTimeoutMs: 100, ccFailuresMax: 3 } });
  x.cc.session('b-slow', () => {});
  x.place(1);
  writeTranscript(x.projects, DIR, 'b-slow', exchanges(1));
  ok(await x.scan());
  assert.equal(x.skip('b-slow').code, 'BACKFILL_UNPLACEABLE');
  assert.match(x.skip('b-slow').message, /cc did not answer: no answer within 100 ms/);
  ok(await x.scan());
  assert.equal(x.cc.describedIds().filter((id) => id === 'b-slow').length, 2, 'asked again: not cached');
  for (const id of ['b-e1', 'b-e2', 'b-e3']) { x.cc.session(id, (send) => send(500, {})); writeTranscript(x.projects, DIR, id, exchanges(1)); }
  const end = await x.scan();
  assert.equal(end.state, 'failed');
  assert.equal(end.error.code, 'BACKFILL_CC_UNAVAILABLE');
  assert.match(end.error.message, /HTTP 500/);
});

// A2 / incremental-scan ruling: placements and parse summaries are reused while a file's size and mtime hold.
test('a second scan of unchanged files makes no describe_session calls and reads no transcript; a changed size re-resolves; fresh ignores the cache; vanished files are pruned; a corrupt cache is moved aside', async (t) => {
  const x = await setup(t);
  const f1 = x.place(1);
  const T = new Date('2026-02-01T00:00:00.000Z');
  fs.utimesSync(f1, T, T);
  const f2 = x.place(2);
  x.cc.unlocatable('b-tmp');
  writeTranscript(x.projects, '-tmp', 'b-tmp', exchanges(1));
  const first = ok(await x.scan());
  assert.equal(first.totals.resolved, 3);
  const asked = x.cc.describedIds().length;

  // Same size and mtime, different bytes: a scan that read it would see no turns.
  fs.writeFileSync(f1, ' '.repeat(fs.statSync(f1).size));
  fs.utimesSync(f1, T, T);
  const second = ok(await x.scan());
  assert.equal(x.cc.describedIds().length, asked, 'no describe_session call');
  assert.deepEqual([second.totals.cached, second.totals.resolved], [3, 0]);
  assert.deepEqual([x.row(KEY(1)).status, x.row(KEY(1)).turns], ['ready', 4], 'the cached summary, not a re-read');
  assert.equal(x.skip('b-tmp').code, 'BACKFILL_UNPLACEABLE', 'a settled refusal is cached too');

  fs.appendFileSync(f2, `${userLine('late', 'one more', at(50))}\n`);
  ok(await x.scan());
  assert.deepEqual(x.cc.describedIds().slice(asked), [B(2), H(2)]);
  assert.equal(x.row(KEY(2)).turns, 5);

  const before = x.cc.describedIds().length;
  ok(await x.scan({ fresh: true }));
  assert.equal(x.cc.describedIds().length - before, 5, 'every file resolved again');
  assert.equal(x.skip(B(1)).code, 'TRANSCRIPT_EMPTY', 'fresh re-reads the file');

  fs.rmSync(f2);
  ok(await x.scan());
  const cached = JSON.parse(fs.readFileSync(x.placements.file, 'utf8'));
  assert.deepEqual(Object.keys(cached.files).sort(), [`-tmp/b-tmp.jsonl`, `${DIR}/${B(1)}.jsonl`]);
  assert.equal(fs.statSync(x.placements.file).mode & 0o777, 0o600);

  fs.writeFileSync(x.placements.file, '{broken');
  const end = await x.scan();
  ok(end);
  assert.equal(fs.readFileSync(`${x.placements.file}.corrupt`, 'utf8'), '{broken');
  assert.match(end.tail, /placement cache was unreadable/);
  assert.equal(end.result.totals.resolved, 2);
});

// --- A3: the live stream and its cursor are never disturbed ---

// A3 / invariant: backfill documents can never collide with the live append stream.
test('backfill documents are cc-backfill:<handle>:<backingId>:p<n> and never cc-session:', async (t) => {
  const x = await setup(t);
  x.place(1);
  ok(await x.scan());
  ok(await x.import([KEY(1)]));
  const docs = retainedDocs(x.hs);
  assert.deepEqual(docs.map((d) => [d.bank, d.document_id, d.update_mode]), [['cc-proj', `cc-backfill:${H(1)}:${B(1)}:p1`, 'replace']]);
  assert.ok(docs.every((d) => !d.document_id.startsWith('cc-session:')));
  assert.deepEqual(docs[0].metadata, { source: 'code-hindsight', ccSessionId: H(1), project: 'proj', worktree: 'wt', kind: 'worker', stage: 'implement', origin: 'backfill', segment: B(1), part: '1' });
  assert.ok(Object.values(docs[0].metadata).every((v) => typeof v === 'string'));
  assert.match(docs[0].context, /Project proj, worktree wt, worker session, stage implement\. Imported from the session's saved transcript after it ended\.$/);
});

// A3 / invariant: the importer only peeks at cursors.json; live retain keeps working while it runs.
test('an import leaves memory/cursors.json byte-identical and a live retain for another session still appends to cc-session:<id> during it', async (t) => {
  const x = await setup(t);
  const memory = createMemory({ scopes: createScopesStore(x.r.dataDir), cc: x.ccClient, hindsight: x.hindsight, cursors: x.cursors, activity: x.activity });
  x.cc.session('s-live', live());
  await memory.retainForHook('s-live', [{ id: 'l1', role: 'user', content: 'hello', timestamp: at(500) }]);
  await memory.idle();
  const file = path.join(x.r.dataDir, 'memory', 'cursors.json');
  const bytes = fs.readFileSync(file);
  x.place(1);
  x.place(2);
  ok(await x.scan());
  ok(await x.import([KEY(1)]));
  assert.deepEqual(fs.readFileSync(file), bytes, 'byte-identical after an import');
  assert.ok(x.cursorCalls.length > 0 && x.cursorCalls.every((k) => k === 'peeker'), `only a read-only peeker: ${[...new Set(x.cursorCalls)]}`);

  const release = x.hs.hold();
  const running = x.import([KEY(2)]);
  await waitFor(() => x.hs.retains().length === 3);
  await memory.retainForHook('s-live', [{ id: 'l1', role: 'user', content: 'hello', timestamp: at(500) }, { id: 'l2', role: 'assistant', content: 'hi', timestamp: at(501) }]);
  release();
  ok(await running);
  await memory.idle();
  assert.equal(lines(x.hs.doc('cc-proj', 'cc-session:s-live').join('\n')).length, 2, 'the live document grew by its append');
  assert.ok(x.hs.doc('cc-proj', backfillDocumentId(H(2), B(2), 1)));
});

// A3 / overlap ruling: only the turns before live memory's first turn are imported.
test('only turns earlier than the live document\'s first turn are imported; a session wholly covered is ALREADY_LIVE', async (t) => {
  const x = await setup(t);
  x.place(1, { body: exchanges(4, { prefix: 'one-' }) });
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, [JSON.stringify({ role: 'assistant', content: 'later', timestamp: at(9) }), JSON.stringify({ role: 'user', content: 'x', timestamp: at(3) })].join('\n'));
  x.place(2);
  x.hs.putDoc('cc-proj', `cc-session:${H(2)}`, JSON.stringify({ role: 'user', content: 'x', timestamp: at(0) }));
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).cutoffAt, x.row(KEY(1)).turns], [at(3), 3]);
  assert.equal(x.skip(B(2)).code, 'ALREADY_LIVE');
  ok(await x.import([KEY(1)]));
  const doc = x.hs.doc('cc-proj', backfillDocumentId(H(1), B(1), 1));
  assert.deepEqual(lines(doc[0]).map((l) => l.timestamp), [at(0), at(1), at(2)]);
});

// A3 / overlap ruling: the cutoff is read from every bank a retain scope renders for the session, not only today's.
test('a live document in another candidate bank (other stage\'s scope) also sets the cutoff', async (t) => {
  const x = await setup(t, { scopes: [scope({ name: 'p', match: { stages: ['plan'] }, bank: 'plan-{project}' }), scope({ name: 'i', match: { stages: ['implement'] }, bank: 'impl-{project}' })] });
  x.place(1, { stage: 'implement', body: exchanges(3) });
  x.hs.putDoc('plan-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'user', content: 'x', timestamp: at(2) }));
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).bank, x.row(KEY(1)).cutoffAt, x.row(KEY(1)).turns], ['impl-proj', at(2), 2]);
});

// A3 / overlap ruling: when live memory's start cannot be known, nothing is imported for that session.
test('a live document without readable timestamps skips LIVE_OVERLAP_UNKNOWN; a pending cursor window skips LIVE_RETAIN_PENDING', async (t) => {
  const x = await setup(t);
  x.place(1);
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'user', content: 'x' }));
  x.place(2);
  x.cursors.set(H(2), { lastId: 'a', lastTs: null, pending: [{ bank: 'cc-proj', session: { project: 'proj', worktree: 'wt', kind: 'worker', stage: null }, lastId: 'b', lastTs: null }] });
  ok(await x.scan());
  assert.equal(x.skip(B(1)).code, 'LIVE_OVERLAP_UNKNOWN');
  assert.match(x.skip(B(1)).message, /bank cc-proj/);
  assert.equal(x.skip(B(2)).code, 'LIVE_RETAIN_PENDING');
});

// --- A4: the dry run, its estimate and the confirm step ---

// A4 / invariant: a scan is read-only towards Hindsight.
test('a scan sends no retain and no operation request; it reports sessions, target banks and a token estimate', async (t) => {
  const x = await setup(t);
  x.place(1);
  x.place(2, { project: 'other' });
  const result = ok(await x.scan());
  assert.deepEqual(x.hs.of('retain', 'operation', 'retry'), []);
  assert.ok(x.hs.of('document').length > 0 && x.hs.requests.every((r) => r.kind === 'document' && r.method === 'GET'));
  const scan = x.backfill.latestScan();
  assert.deepEqual(scan.sessions.map((s) => [s.key, s.bank]).sort(), [[KEY(1), 'cc-proj'], [KEY(2), 'cc-other']]);
  const row = x.row(KEY(1));
  assert.deepEqual(row.estimate, estimateDocument(row.chars, 'manual'));
  assert.ok(row.estimate.inputTokens > 0 && row.estimate.outputTokens > 0);
  assert.deepEqual(scan.llm, { mode: 'manual', model: 'model-x' });
  assert.deepEqual(scan.basis, BACKFILL_ESTIMATE);
  assert.equal(scan.totals.estimate.inputTokens, x.row(KEY(1)).estimate.inputTokens + x.row(KEY(2)).estimate.inputTokens);
  assert.equal(result.scanId, scan.scanId);
});

// A4 / invariant: LLM mode none means no LLM calls, so no LLM tokens.
test('with LLM mode none the estimate has zero LLM tokens', async (t) => {
  const x = await setup(t, { llmMode: 'none' });
  x.place(1);
  ok(await x.scan());
  const row = x.row(KEY(1));
  assert.deepEqual([row.estimate.inputTokens, row.estimate.outputTokens], [0, 0]);
  assert.ok(row.estimate.chunks >= 1);
  assert.deepEqual(x.backfill.latestScan().llm, { mode: 'none', model: null });
});

// A4 / invariant: nothing is imported without an explicit confirm of the current scan (through the HTTP routes).
test('import is refused CONFIRMATION_REQUIRED without confirm:true, BACKFILL_STALE for an older scanId or after a scope change, HINDSIGHT_NOT_READY when Hindsight is down', async (t) => {
  const cc = await startFakeCc(t);
  const hs = await startFakeHindsight(t);
  const state = { ready: true };
  const r0 = mkRoot(t);
  const { projects } = claudeDir(r0.root);
  const { url } = await boot(t, { cc: cc.url, claudeProjectsDir: projects, hindsight: () => (state.ready ? { apiUrl: hs.url, apiKey: FAKE_KEY } : null) });
  const json = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const post = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const runJob = async (kind, body) => {
    const res = await post(`/-/api/jobs/${kind}`, body);
    assert.equal(res.status, 200, await res.clone().text());
    const { id } = await res.json();
    return waitFor(async () => { const j = await (await fetch(`${url}/-/api/jobs/${id}`)).json(); return j.state !== 'running' && j; });
  };
  assert.equal((await post('/-/api/jobs/backfill-scan', {})).status, 409, 'BACKFILL_NO_SCOPES before any scope');
  assert.equal((await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: json, body: JSON.stringify({ scopes: [scope()] }) })).status, 200);
  cc.segment(B(1), H(1));
  cc.retired(H(1));
  writeTranscript(projects, DIR, B(1), exchanges(1));
  assert.deepEqual(await (await fetch(`${url}/-/api/memory/backfill`)).json(), { scan: null });
  const first = await runJob('backfill-scan', {});
  assert.equal(first.state, 'done', JSON.stringify(first.error));
  assert.deepEqual(first.progress, { done: 1, total: 1, unit: 'files' });
  const old = (await (await fetch(`${url}/-/api/memory/backfill`)).json()).scan;
  assert.equal(old.sessions[0].key, KEY(1));

  const refused = async (body, status, code) => {
    const res = await post('/-/api/jobs/backfill-import', body);
    assert.equal(res.status, status);
    assert.equal((await res.json()).code, code);
  };
  await refused({ scanId: old.scanId, sessions: [KEY(1)] }, 400, 'CONFIRMATION_REQUIRED');
  await refused({ scanId: old.scanId, sessions: [KEY(1)], confirm: 'yes' }, 400, 'CONFIRMATION_REQUIRED');
  await runJob('backfill-scan', {});
  await refused({ scanId: old.scanId, sessions: [KEY(1)], confirm: true }, 409, 'BACKFILL_STALE');
  const latest = (await (await fetch(`${url}/-/api/memory/backfill`)).json()).scan;
  await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: json, body: JSON.stringify({ scopes: [scope({ bank: 'renamed-{project}' })] }) });
  await refused({ scanId: latest.scanId, sessions: [KEY(1)], confirm: true }, 409, 'BACKFILL_STALE');
  await runJob('backfill-scan', {});
  const current = (await (await fetch(`${url}/-/api/memory/backfill`)).json()).scan;
  await refused({ scanId: current.scanId, sessions: [], confirm: true }, 400, 'BAD_REQUEST');
  await refused({ scanId: current.scanId, sessions: ['h-9:b-9'], confirm: true }, 400, 'BAD_REQUEST');
  state.ready = false;
  await refused({ scanId: current.scanId, sessions: [KEY(1)], confirm: true }, 503, 'HINDSIGHT_NOT_READY');
  assert.deepEqual(hs.retains(), [], 'nothing was retained by any refused request');
  state.ready = true;
  const done = await runJob('backfill-import', { scanId: current.scanId, sessions: [KEY(1)], confirm: true });
  assert.equal(done.state, 'done', JSON.stringify(done.error));
  assert.deepEqual(hs.retains().map((q) => q.bank), ['renamed-proj']);
});

// --- A5: idempotent re-runs, deterministic ids, original timestamps ---

// A5 / invariant: a re-run never resends what Hindsight already holds.
test('re-running an import sends nothing: existing documents count as already imported', async (t) => {
  const x = await setup(t);
  x.place(1);
  x.place(2);
  ok(await x.scan());
  const first = ok(await x.import([KEY(1), KEY(2)]));
  assert.deepEqual([first.sessions, first.documents], [2, { ...NONE, sent: 2 }]);
  const second = ok(await x.import([KEY(1), KEY(2)]));
  assert.deepEqual(second.documents, { ...NONE, alreadyImported: 2 });
  assert.equal(x.hs.retains().length, 2);
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).status, x.row(KEY(2)).status], ['imported', 'imported']);
  assert.throws(() => x.jobs.start('backfill-import', { scanId: x.backfill.latestScan().scanId, sessions: [KEY(1)], confirm: true }), { code: 'BAD_REQUEST' }, 'an imported row cannot be selected');
});

// A5 / invariant: a lost ack never doubles extraction; a queued operation is left alone; a failed one is retried, not deduped away.
test('a resend carries the same operation_id; a queued operation is not resent; a failed operation is retried through the retry route', async (t) => {
  const x = await setup(t);
  const files = [1, 2, 3].map((n) => x.place(n, { body: exchanges(1, { prefix: `s${n}-` }) }));
  ok(await x.scan());
  const op = await Promise.all(files.map((f, i) => onePartOp(f, i + 1)));
  x.hs.opStatus(op[1], 'processing');
  x.hs.opStatus(op[2], 'failed');
  x.hs.retainStatus = 503;
  const failed = await x.import([KEY(1)]);
  assert.equal(failed.state, 'failed');
  x.hs.retainStatus = null;
  const result = ok(await x.import([KEY(1), KEY(2), KEY(3)]));
  assert.deepEqual(result.documents, { ...NONE, sent: 1, queued: 1, retried: 1 });
  assert.deepEqual(x.hs.retains().map((q) => q.body.operation_id), [op[0], op[0]], 'the resend repeats the operation id; sessions 2 and 3 were not resent');
  assert.deepEqual(x.hs.of('retry').map((q) => q.id), [op[2]]);
});

// A5 / invariant: backfilled memories keep their original time; nothing is dated "now".
test('item timestamp is the first turn\'s original timestamp and every line keeps its own; a part without timestamps is dated by the file mtime', async (t) => {
  const x = await setup(t);
  x.place(1, { body: [userLine('n0', 'no time', null), ...exchanges(1, { fromSec: 40 })] });
  const mtimeMs = Date.parse('2025-06-01T12:00:00.000Z');
  const f2 = x.place(2, { body: [userLine('n1', 'no time', null), assistantLine('n2', 'none either', null)] });
  fs.utimesSync(f2, new Date(mtimeMs), new Date(mtimeMs));
  ok(await x.scan());
  ok(await x.import([KEY(1), KEY(2)]));
  const [one, two] = retainedDocs(x.hs);
  assert.equal(one.timestamp, at(40));
  assert.deepEqual(lines(one.content).map((l) => l.timestamp), [undefined, at(40), at(41)]);
  assert.equal(two.timestamp, new Date(mtimeMs).toISOString());
});

// A5 / invariant: a long segment is split at turn boundaries into parts with stable ids.
test('a segment over documentMaxChars is split at turn boundaries into p1..pn with deterministic ids', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 300 } });
  x.place(1, { body: exchanges(5, { text: (i, who) => `${who} ${i} ${'w'.repeat(60)}` }) });
  ok(await x.scan());
  const n = x.row(KEY(1)).documents;
  assert.ok(n > 2, `split into ${n} parts`);
  ok(await x.scan());
  assert.equal(x.row(KEY(1)).documents, n, 'the same parts on every scan');
  ok(await x.import([KEY(1)]));
  const docs = retainedDocs(x.hs);
  assert.deepEqual(docs.map((d) => d.document_id), Array.from({ length: n }, (_, i) => backfillDocumentId(H(1), B(1), i + 1)));
  assert.ok(docs.every((d) => d.content.length <= 300));
  assert.equal(docs.flatMap((d) => lines(d.content)).length, 10, 'every turn in exactly one part');
  assert.deepEqual(docs.map((d) => d.metadata.part), Array.from({ length: n }, (_, i) => String(i + 1)));
});

// --- A6: reporting, failures and changed files ---

// A6 / invariant: one summary entry per job (the ring keeps live entries), plus one per failed session.
test('a scan and an import each add one activity entry; a failed session adds an error entry with its code', async (t) => {
  const x = await setup(t);
  // Pinned mtimes: the activity entries follow scan order, which is newest-modified first.
  fs.utimesSync(x.place(1), new Date(2e12), new Date(2e12));
  fs.utimesSync(x.place(2, { project: 'other', stage: 'plan' }), new Date(1e12), new Date(1e12));
  ok(await x.scan());
  x.hs.retainStatus = 400;
  const result = ok(await x.import([KEY(1), KEY(2)]));
  assert.deepEqual(result.failed.map((f) => [f.key, f.code]).sort(), [[KEY(1), 'RETAIN_FAILED'], [KEY(2), 'RETAIN_FAILED']]);
  const entries = x.activity.list().reverse();
  assert.deepEqual(entries.map((e) => [e.event, e.outcome]), [['backfill-scan', 'ok'], ['backfill-import', 'error'], ['backfill-import', 'error'], ['backfill-import', 'ok']]);
  assert.deepEqual([entries[0].count, entries[0].banks], [2, ['cc-proj', 'cc-other']]);
  assert.match(entries[0].message, /2 transcripts: 2 ready, 0 already imported, 0 skipped/);
  assert.deepEqual([entries[2].sessionId, entries[2].project, entries[2].stage, entries[2].banks, entries[2].code], [H(2), 'other', 'plan', ['cc-other'], 'RETAIN_FAILED']);
  assert.match(entries[3].message, /2 failed/);
});

// A6 / invariant: Hindsight going away stops the import (it is not a per-session failure); a re-run resumes without duplicates.
test('Hindsight going down mid-import stops the job failed with progress kept; a re-run completes without duplicates', async (t) => {
  const x = await setup(t);
  x.place(1);
  x.place(2);
  x.place(3);
  ok(await x.scan());
  const release = x.hs.hold();
  const running = x.import([KEY(1), KEY(2), KEY(3)]);
  await waitFor(() => x.hs.retains().length === 1);
  x.hs.down = true;
  release();
  const end = await running;
  assert.equal(end.state, 'failed');
  assert.equal(end.error.code, 'RETAIN_FAILED');
  assert.match(end.error.message, /importing again resumes/);
  const stopped = x.activity.list()[0];
  assert.deepEqual([stopped.event, stopped.outcome, stopped.code, stopped.count], ['backfill-import', 'error', 'RETAIN_FAILED', 1]);
  x.hs.down = false;
  const again = ok(await x.import([KEY(1), KEY(2), KEY(3)]));
  assert.deepEqual(again.documents, { ...NONE, sent: 2, alreadyImported: 1 });
  for (const n of [1, 2, 3]) assert.equal(x.hs.doc('cc-proj', backfillDocumentId(H(n), B(n), 1)).length, 1);
  assert.equal(x.hs.retains().length, 3);
});

// A6 / invariant: an import sends exactly what the confirmed dry run described.
test('a changed transcript between scan and import is skipped TRANSCRIPT_CHANGED', async (t) => {
  const x = await setup(t);
  const f = x.place(1);
  x.place(2);
  ok(await x.scan());
  fs.appendFileSync(f, `${userLine('new', 'more', at(90))}\n`);
  const result = ok(await x.import([KEY(1), KEY(2)]));
  assert.deepEqual(result.skipped.map((s) => [s.key, s.code]), [[KEY(1), 'TRANSCRIPT_CHANGED']]);
  assert.deepEqual(retainedDocs(x.hs).map((d) => d.document_id), [backfillDocumentId(H(2), B(2), 1)]);
});

// A6 / invariant: Cancel stops a running import cleanly and is never logged as a success; a re-run picks up the rest.
test('a cancelled import ends cancelled and logs a skipped (not ok) summary', async (t) => {
  const x = await setup(t);
  x.place(1);
  x.place(2);
  ok(await x.scan());
  const release = x.hs.hold();
  const { job, done } = x.jobs.start('backfill-import', { scanId: x.backfill.latestScan().scanId, sessions: [KEY(1), KEY(2)], confirm: true });
  await waitFor(() => x.hs.retains().length === 1);
  x.jobs.cancel(job.id);
  release();
  const end = await done;
  assert.equal(end.state, 'cancelled');
  assert.deepEqual([x.activity.list()[0].event, x.activity.list()[0].outcome], ['backfill-import', 'skipped']);
  assert.match(x.activity.list()[0].message, /^Cancelled: /);
  const again = ok(await x.import([KEY(1), KEY(2)]));
  assert.equal(again.documents.sent + again.documents.alreadyImported + again.documents.queued, 2);
});

// --- Review round: content-checked parts, single reads, caps, auth, swaps ---

// A5 / invariant: a stored part counts as imported only when it holds exactly what would be sent now.
test('a cutoff that moves earlier makes stored parts outdated and orphaned: the import replaces and deletes them, then a re-run sends nothing', async (t) => {
  // One exchange (two rendered lines) per part.
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 300 } });
  x.place(1, { body: exchanges(5, { text: (i, who) => `${who} ${i} ${'w'.repeat(60)}` }) });
  ok(await x.scan());
  const before = x.row(KEY(1)).documents;
  ok(await x.import([KEY(1)]));
  assert.ok(before >= 4, `${before} parts`);
  // Live memory now starts at turn 3: only u0, a0, u1 are earlier.
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'assistant', content: 'x', timestamp: at(3) }));
  ok(await x.scan());
  const row = x.row(KEY(1));
  assert.equal(row.status, 'ready', 'not "imported": the stored parts hold turns live memory now has');
  assert.equal(row.stored + row.outdated, row.documents);
  assert.deepEqual([row.documents, row.stored, row.outdated, row.orphans], [2, 1, 1, before - 2], 'p1 [u0, a0] unchanged; p2 now [u1] alone');
  const deletesBefore = x.hs.of('delete').length;
  const result = ok(await x.import([KEY(1)]));
  assert.equal(result.documents.replaced, row.outdated);
  assert.equal(result.documents.deleted, row.orphans);
  assert.deepEqual(x.hs.of('delete').slice(deletesBefore).map((q) => q.id), Array.from({ length: row.orphans }, (_, i) => backfillDocumentId(H(1), B(1), before - i)), 'only the listed orphans, highest first');
  const kept = Array.from({ length: row.documents }, (_, i) => x.hs.doc('cc-proj', backfillDocumentId(H(1), B(1), i + 1))[0]);
  assert.deepEqual(kept.flatMap((c) => lines(c)).map((l) => l.timestamp), [at(0), at(1), at(2)]);
  assert.equal(x.hs.doc('cc-proj', backfillDocumentId(H(1), B(1), row.documents + 1)), undefined);
  const replacedOps = x.hs.retains().slice(-row.outdated).map((q) => q.body.operation_id);
  const firstOps = x.hs.retains().slice(0, before).map((q) => q.body.operation_id);
  assert.ok(replacedOps.every((o) => !firstOps.includes(o)), 'a replacement carries a fresh operation id');
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).status, x.row(KEY(1)).orphans], ['imported', 0]);
});

// A5 / invariant: an import of a partly stored session sends only the parts Hindsight lacks.
test('a partially imported session sends only its missing parts', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 300 } });
  x.place(1, { body: exchanges(4, { text: (i, who) => `${who} ${i} ${'w'.repeat(60)}` }) });
  ok(await x.scan());
  const n = x.row(KEY(1)).documents;
  assert.ok(n > 2);
  // An earlier import that stopped after its first part.
  const release = x.hs.hold();
  const running = x.import([KEY(1)]);
  await waitFor(() => x.hs.retains().length === 1);
  x.hs.down = true;
  release();
  assert.equal((await running).state, 'failed');
  x.hs.down = false;
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).status, x.row(KEY(1)).stored, x.row(KEY(1)).outdated], ['ready', 1, 0]);
  const from = x.hs.retains().length;
  const result = ok(await x.import([KEY(1)]));
  assert.deepEqual(result.documents, { ...NONE, sent: n - 1, alreadyImported: 1 });
  assert.deepEqual(x.hs.retains().slice(from).map((q) => q.body.items[0].metadata.part), Array.from({ length: n - 1 }, (_, i) => String(i + 2)));
});

// A2 / invariant: a transcript that cannot be read is skipped on its own; Hindsight checks go on for the rest.
test('a transcript read failure while checking overlap skips that file TRANSCRIPT_UNREADABLE and keeps Hindsight checks on for the scan', async (t) => {
  const x = await setup(t);
  const f1 = x.place(1);
  x.place(2);
  ok(await x.scan());
  ok(await x.import([KEY(2)]));
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'user', content: 'x', timestamp: at(2) }));
  fs.chmodSync(f1, 0o000);
  ok(await x.scan());
  assert.equal(x.skip(B(1)).code, 'TRANSCRIPT_UNREADABLE');
  assert.match(x.skip(B(1)).message, /EACCES/);
  assert.equal(x.backfill.latestScan().hindsightChecked, true);
  assert.equal(x.row(KEY(2)).status, 'imported');
});

// A2 / memory-bound invariant: a scan opens each transcript at most once, even with a cutoff, and keeps no turn text.
test('a scan reads each transcript at most once; a session over sessionMaxChars is skipped TRANSCRIPT_SESSION_TOO_LARGE', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, sessionMaxChars: 2000 } });
  const f1 = x.place(1, { body: exchanges(4) });
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'user', content: 'x', timestamp: at(3) }));
  const f2 = x.place(2, { body: exchanges(40, { text: (i, who) => `${who} ${i} ${'z'.repeat(80)}` }) });
  const opened = [];
  const real = fs.createReadStream;
  fs.createReadStream = (file, ...rest) => { opened.push(file); return real(file, ...rest); };
  t.after(() => { fs.createReadStream = real; });
  ok(await x.scan({ fresh: true }));
  assert.deepEqual([opened.filter((f) => f === f1).length, opened.filter((f) => f === f2).length], [1, 1]);
  assert.deepEqual([x.row(KEY(1)).turns, x.row(KEY(1)).cutoffAt], [3, at(3)]);
  assert.equal(x.skip(B(2)).code, 'TRANSCRIPT_SESSION_TOO_LARGE');
  assert.match(x.skip(B(2)).message, /2000/);
});

// A5 / invariant: a turn too large for one document skips its session; nothing is truncated, and nothing is sent.
test('a turn larger than documentMaxChars skips its session TRANSCRIPT_TURN_TOO_LARGE', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 400 } });
  x.place(1, { body: [...exchanges(1), userLine('big', 'b'.repeat(500), at(10))] });
  x.place(2);
  ok(await x.scan());
  assert.equal(x.skip(B(1)).code, 'TRANSCRIPT_TURN_TOO_LARGE');
  assert.match(x.skip(B(1)).message, /nothing is truncated/);
  assert.equal(x.row(KEY(2)).status, 'ready');
});

// A6 / invariant: an auth refusal is Hindsight being unusable, not one bad item: the job stops.
test('a 401 or 403 from Hindsight stops the import; another 4xx fails only its session', async (t) => {
  for (const status of [401, 403]) {
    const x = await setup(t);
    x.place(1);
    x.place(2);
    ok(await x.scan());
    x.hs.allStatus = status;
    const from = x.hs.requests.length;
    const end = await x.import([KEY(1), KEY(2)]);
    assert.equal(end.state, 'failed', `HTTP ${status}`);
    assert.deepEqual([end.error.code, end.error.params.status], ['RETAIN_FAILED', status]);
    assert.equal(x.hs.requests.length - from, 1, 'stopped at the first refused call');
  }
  const x = await setup(t);
  x.place(1);
  x.place(2);
  ok(await x.scan());
  x.hs.retainStatus = 422;
  const result = ok(await x.import([KEY(1), KEY(2)]));
  assert.equal(result.failed.length, 2);
});

// A6 / invariant: the import sends the very file the scan saw; a swapped file (even a symlink to the same bytes) is a change.
test('a transcript swapped for a symlink between scan and import is skipped TRANSCRIPT_CHANGED', async (t) => {
  const x = await setup(t);
  const f = x.place(1);
  ok(await x.scan());
  const copy = path.join(x.r.root, 'copy.jsonl');
  fs.copyFileSync(f, copy);
  const st = fs.statSync(f);
  fs.utimesSync(copy, st.atime, st.mtime);
  fs.rmSync(f);
  fs.symlinkSync(copy, f);
  const result = ok(await x.import([KEY(1)]));
  assert.deepEqual(result.skipped.map((k) => k.code), ['TRANSCRIPT_CHANGED']);
  assert.deepEqual(x.hs.retains(), []);
});

// A4 / invariant: no import without a scan to confirm.
test('an import before any scan is refused BACKFILL_STALE', async (t) => {
  const x = await setup(t);
  assert.throws(() => x.jobs.start('backfill-import', { scanId: 'anything', sessions: ['h-1:b-1'], confirm: true }), { code: 'BACKFILL_STALE' });
});

// A6 / invariant: Cancel stops a scan inside a file's placement; what was learned before it is kept.
test('cancelling a scan mid-file ends it cancelled and keeps the placements learned so far', async (t) => {
  const x = await setup(t);
  x.place(1);
  writeTranscript(x.projects, DIR, 'b-2-hangs', exchanges(1));
  x.cc.session('b-2-hangs', () => {});
  const { job, done } = x.jobs.start('backfill-scan', {});
  await waitFor(() => x.cc.describedIds().includes('b-2-hangs'));
  x.jobs.cancel(job.id);
  const end = await done;
  assert.equal(end.state, 'cancelled');
  assert.equal(x.backfill.latestScan(), null, 'a cancelled scan publishes no result');
  const cached = JSON.parse(fs.readFileSync(x.placements.file, 'utf8'));
  assert.deepEqual(Object.keys(cached.files), [`${DIR}/${B(1)}.jsonl`]);
});

// --- Review round 2: the import acts only on the confirmed plan ---

/** A session imported as `parts` one-exchange parts, then a cutoff that keeps only u0, a0, u1: two parts now, the rest orphans. */
async function orphaned(t) {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 300 } });
  const file = x.place(1, { body: exchanges(6, { text: (i, who) => `${who} ${i} ${'w'.repeat(60)}` }) });
  ok(await x.scan());
  ok(await x.import([KEY(1)]));
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'assistant', content: 'x', timestamp: at(3) }));
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).documents, x.row(KEY(1)).orphans], [2, 4], 'p3..p6 orphaned');
  return { x, file };
}
const stored = (x) => [...x.hs.banks.get('cc-proj').docs.keys()].filter((k) => k.startsWith('cc-backfill:')).map((k) => Number(k.split(':p')[1])).sort((a, b) => a - b);

// A5 / invariant: no stored part is ever stranded: deletion runs highest first, and the scan's probe crosses gaps.
test('an interrupted deletion leaves a block the next scan finds; the orphan probe crosses gaps', async (t) => {
  const { x } = await orphaned(t);
  x.hs.script.delete = [null, 503];
  const end = await x.import([KEY(1)]);
  assert.equal(end.state, 'failed', 'a 5xx on DELETE stops the job');
  assert.deepEqual(stored(x), [1, 2, 3, 4, 5], 'p6 deleted first; p3..p5 left as one block');
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).status, x.row(KEY(1)).orphans], ['ready', 3]);
  // A gap (as an ascending deletion interrupted after its first delete would leave) does not hide the rest.
  x.hs.banks.get('cc-proj').docs.delete(backfillDocumentId(H(1), B(1), 3));
  ok(await x.scan());
  assert.equal(x.row(KEY(1)).orphans, 2);
  const result = ok(await x.import([KEY(1)]));
  assert.equal(result.documents.deleted, 2);
  assert.deepEqual(stored(x), [1, 2]);
  ok(await x.scan());
  assert.deepEqual([x.row(KEY(1)).status, x.row(KEY(1)).orphans], ['imported', 0]);
});

// A4 / invariant: the import does exactly what the confirmed dry run showed, or nothing for that session.
test('a plan that changed between scan and import is skipped with no delete and no send', async (t) => {
  const { x, file } = await orphaned(t);
  const sends = x.hs.retains().length;
  // Live memory's start moves again after the scan.
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'assistant', content: 'x', timestamp: at(1) }));
  const moved = ok(await x.import([KEY(1)]));
  assert.deepEqual(moved.skipped.map((k) => k.code), ['LIVE_CUTOFF_MOVED']);
  assert.deepEqual([x.hs.of('delete').length, x.hs.retains().length], [0, sends]);

  // The file rewritten in place: same size, mtime and inode, other content.
  x.hs.putDoc('cc-proj', `cc-session:${H(1)}`, JSON.stringify({ role: 'assistant', content: 'x', timestamp: at(3) }));
  const T = new Date('2026-03-01T00:00:00.000Z');
  fs.utimesSync(file, T, T);
  ok(await x.scan());
  const st = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('user 0', 'USER 0'));
  fs.utimesSync(file, T, T);
  assert.deepEqual([fs.statSync(file).ino, fs.statSync(file).size, fs.statSync(file).mtimeMs], [st.ino, st.size, st.mtimeMs]);
  const rewritten = ok(await x.import([KEY(1)]));
  assert.deepEqual(rewritten.skipped.map((k) => k.code), ['TRANSCRIPT_CHANGED']);
  assert.match(rewritten.skipped[0].message, /inode|content/);
  assert.deepEqual([x.hs.of('delete').length, x.hs.retains().length], [0, sends]);
});

// A6 / invariant: what a session sent before it stopped is always counted.
test('a session that fails part-way still counts the parts it sent', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 300 } });
  x.place(1, { body: exchanges(3, { text: (i, who) => `${who} ${i} ${'w'.repeat(60)}` }) });
  ok(await x.scan());
  x.hs.script.retain = [null, 400];
  const result = ok(await x.import([KEY(1)]));
  assert.deepEqual(result.failed.map((f) => f.code), ['RETAIN_FAILED']);
  assert.equal(result.documents.sent, 1);
  assert.equal(result.sessions, 0);
  assert.match(x.activity.list()[0].message, /^0 sessions finished, 1 documents sent/);
});

// A6 / invariant: an import never reports success for parts the file no longer yields.
test('a second pass that does not yield every planned part skips the session TRANSCRIPT_CHANGED', async (t) => {
  const x = await setup(t, { limits: { ...BACKFILL_LIMITS, documentMaxChars: 300 } });
  const file = x.place(1, { body: exchanges(3, { text: (i, who) => `${who} ${i} ${'w'.repeat(60)}` }) });
  ok(await x.scan());
  // The import's second read sees only the first exchange (the file cut short between its two reads).
  const short = path.join(x.r.root, 'short.jsonl');
  fs.writeFileSync(short, `${fs.readFileSync(file, 'utf8').split('\n').slice(0, 2).join('\n')}\n`);
  const real = fs.createReadStream;
  let opens = 0;
  fs.createReadStream = (f, ...rest) => real(f === file && ++opens === 2 ? short : f, ...rest);
  t.after(() => { fs.createReadStream = real; });
  const result = ok(await x.import([KEY(1)]));
  assert.deepEqual(result.skipped.map((k) => k.code), ['TRANSCRIPT_CHANGED']);
  assert.deepEqual([result.sessions, result.documents.sent], [0, 1], 'p1 went out before the shortfall was seen, and is counted');
  assert.deepEqual(x.hs.retains().map((q) => q.body.items[0].metadata.part), ['1']);
});

// A2 / invariant: a placement cache of another version is never read as this one's.
test('a version-1 placement cache is moved aside and the cache rebuilt', async (t) => {
  const x = await setup(t);
  x.place(1);
  fs.mkdirSync(path.dirname(x.placements.file), { recursive: true });
  const old = JSON.stringify({ version: 1, files: { [`${DIR}/${B(1)}.jsonl`]: { size: 1, mtimeMs: 1, handle: H(1), outcome: 'placed', summary: { turns: 4, parts: [100] } } } });
  fs.writeFileSync(x.placements.file, old);
  const end = await x.scan();
  ok(end);
  assert.equal(fs.readFileSync(`${x.placements.file}.corrupt`, 'utf8'), old);
  assert.match(end.tail, /another version/);
  assert.equal(end.result.totals.resolved, 1);
  assert.equal(JSON.parse(fs.readFileSync(x.placements.file, 'utf8')).version, 2);
  assert.equal(x.row(KEY(1)).status, 'ready');
});

// A4 / invariant: only a dry run that checked Hindsight (overlap, stored and outdated parts) can be confirmed, whatever the caller.
test('an import of a scan made while Hindsight was not ready is refused BACKFILL_UNCHECKED', async (t) => {
  const x = await setup(t);
  x.place(1);
  x.state.ready = false;
  ok(await x.scan());
  assert.equal(x.backfill.latestScan().hindsightChecked, false);
  x.state.ready = true;
  assert.throws(() => x.jobs.start('backfill-import', { scanId: x.backfill.latestScan().scanId, sessions: [KEY(1)], confirm: true }), (e) => e.code === 'BACKFILL_UNCHECKED' && /scan again once Hindsight is ready/.test(e.message));
  assert.deepEqual(x.hs.requests, []);
  ok(await x.scan());
  ok(await x.import([KEY(1)]));
});
