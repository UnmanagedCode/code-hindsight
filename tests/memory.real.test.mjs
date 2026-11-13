// Gated (RUN_REAL_DOCKER=1): scoped memory against a real Hindsight (LLM none, the locally present
// pinned images). Each case boots its own throwaway `code-hindsight-test-<hex>` stack on a temp data
// dir; the hook is the real claude/hooks/hook.mjs talking to that stack's backend.
//
// The live case (CODE_HINDSIGHT_LIVE_CC + CODE_HINDSIGHT_LIVE_SESSION) points the scratch backend's
// cc at the live cc for READ-ONLY describe_session and /api/playbooks; it never touches the live
// plugin, its containers or its data. With RUN_REAL_CLI=1 it also runs a real `claude -p`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { bootRealStack, hindsightApi, realSkipReason } from './support/realStack.mjs';
import { startFakeCc, live } from './support/fakeCc.mjs';
import { runHook } from './support/runHook.mjs';
import { createCcClient } from '../src/ccSession.js';
import { REPO, waitFor } from './helpers.mjs';

const skip = realSkipReason('full') || false;
const LIVE_CC = process.env.CODE_HINDSIGHT_LIVE_CC;
const LIVE_SESSION = process.env.CODE_HINDSIGHT_LIVE_SESSION;

const docUrl = (bank, docId) => `/v1/default/banks/${bank}/documents/${encodeURIComponent(docId)}`;
const msg = (type, uuid, text, n) => ({ type, uuid, timestamp: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`, message: { role: type, content: text } });
const count = (text, needle) => (text.match(new RegExp(needle, 'g')) ?? []).length;

function transcript(root, name, lines) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

/** Run the Stop hook for the last assistant line of `lines`, then let the backend's worker finish. */
async function stop(app, env, root, name, lines) {
  const last = lines.at(-1).message.content;
  const r = await runHook('retain', { transcript_path: transcript(root, name, lines), last_assistant_message: last }, env);
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  await app.memory.idle();
}

test('real Hindsight: retain through the hook, recall, one growing document, idempotent operation ids, uncreated banks and missing documents', { skip, timeout: 20 * 60_000 }, async (t) => {
  const cc = await startFakeCc(t);
  const { app, url, r } = await bootRealStack(t, { conductorUrl: cc.url });
  await app.supervisor.ensureRunning();
  assert.equal(app.supervisor.status().state, 'ready', JSON.stringify(app.supervisor.status().error));
  const conn = app.supervisor.connection();
  cc.session('s1', live({ project: 'realproj' }));
  app.scopes.save([{ name: 'all', match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'] }]);
  const env = { CC_SESSION_ID: 's1', CODE_HINDSIGHT_HOOK_URL: url };
  const bank = 'cc-realproj';
  const docId = 'cc-session:s1';
  const docText = async () => (await hindsightApi(conn, 'GET', docUrl(bank, docId))).json?.original_text ?? '';

  const first = [msg('user', 'u1', 'ALPHA-Q where is the bicycle?', 1), msg('assistant', 'a1', 'ALPHA-A the violet bicycle is behind the library', 2)];
  await stop(app, env, r.root, 't1.jsonl', first);
  await waitFor(async () => (await docText()).includes('ALPHA-A'), { timeoutMs: 120_000, stepMs: 500 });

  await t.test('recall through the hook returns what was retained (LLM none stores chunks; recall filters no type)', async () => {
    const out = await waitFor(async () => {
      const x = await runHook('recall', { prompt: 'Where is the violet bicycle?' }, env);
      return x.stdout ? x : null;
    }, { timeoutMs: 120_000, stepMs: 1000 });
    const ctx = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /<hindsight_memory>/);
    assert.match(ctx, /\[cc-realproj\]/);
    assert.match(ctx, /violet bicycle/);
  });

  await t.test('a second Stop with an overlapping transcript appends only the new turns to the same document', async () => {
    const second = [...first, msg('user', 'u2', 'BETA-Q and the scooter?', 3), msg('assistant', 'a2', 'BETA-A the scarlet scooter is chained to the fence', 4)];
    await stop(app, env, r.root, 't2.jsonl', second);
    await waitFor(async () => (await docText()).includes('BETA-A'), { timeoutMs: 120_000, stepMs: 500 });
    const text = await docText();
    for (const token of ['ALPHA-Q', 'ALPHA-A', 'BETA-Q', 'BETA-A']) assert.equal(count(text, token), 1, `${token} appears once`);
    const docs = await hindsightApi(conn, 'GET', `/v1/default/banks/${bank}/documents?limit=100`);
    const items = docs.json?.items ?? docs.json?.documents ?? [];
    assert.equal(items.filter((d) => d.id === docId).length, 1, `one document, got ${docs.text.slice(0, 300)}`);
  });

  await t.test('re-sending a retain under the same operation_id appends nothing', async () => {
    const operationId = crypto.randomUUID();
    const body = { items: [{ content: 'ZETA-ONCE', document_id: docId, update_mode: 'append' }], async: true, operation_id: operationId };
    const done = async () => (await hindsightApi(conn, 'GET', `/v1/default/banks/${bank}/operations/${operationId}`)).json?.status;
    assert.equal((await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories`, body)).status, 200);
    await waitFor(async () => (await docText()).includes('ZETA-ONCE'), { timeoutMs: 120_000, stepMs: 500 });
    await waitFor(async () => (await done()) === 'completed', { timeoutMs: 120_000, stepMs: 500 });
    assert.equal((await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories`, body)).status, 200);
    await waitFor(async () => (await done()) === 'completed', { timeoutMs: 120_000, stepMs: 500 });
    assert.equal(count(await docText(), 'ZETA-ONCE'), 1);
  });

  await t.test('recall of a bank that was never created answers 404, which the hook path turns into a quiet memoryless turn', async () => {
    assert.equal((await hindsightApi(conn, 'POST', '/v1/default/banks/never-created/memories/recall', { query: 'x' })).status, 404);
    cc.session('g', live({ project: 'ghostproj' }));
    const x = await runHook('recall', { prompt: 'anything' }, { ...env, CC_SESSION_ID: 'g' });
    assert.deepEqual([x.code, x.stdout, x.stderr], [0, '', '']);
    assert.deepEqual(app.activity.list().filter((e) => e.sessionId === 'g' && e.outcome === 'error'), []);
  });

  await t.test('an append onto a document that does not exist creates it', async () => {
    const id = 'cc-session:fresh';
    assert.equal((await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories`, { items: [{ content: 'GAMMA-NEW', document_id: id, update_mode: 'append' }], async: false })).status, 200);
    const got = await hindsightApi(conn, 'GET', docUrl(bank, id));
    assert.equal(got.status, 200);
    assert.match(got.json.original_text, /GAMMA-NEW/);
  });
});

test('live cc: the scratch backend places the live session by its real project, kind and stage, and a scope for another stage leaves it memoryless', { skip: skip || !(LIVE_CC && LIVE_SESSION) || false, timeout: 20 * 60_000 }, async (t) => {
  const session = await createCcClient({ conductorUrl: LIVE_CC }).resolveSession(LIVE_SESSION);
  const { app, url, r } = await bootRealStack(t, { conductorUrl: LIVE_CC });
  await app.supervisor.ensureRunning();
  assert.equal(app.supervisor.status().state, 'ready', JSON.stringify(app.supervisor.status().error));
  const conn = app.supervisor.connection();
  const match = { projects: [session.project], sessions: [session.kind], ...(session.stage ? { stages: [session.stage] } : {}) };
  const scope = (over = {}) => ({ name: 'live', match, bank: 'live-{project}-{kind}', actions: ['recall', 'retain'], ...over });
  app.scopes.save([scope()]);
  const env = { CC_SESSION_ID: LIVE_SESSION, CODE_HINDSIGHT_HOOK_URL: url };
  const bank = `live-${session.project.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[._-]+/, '')}-${session.kind}`;
  const token = `LIVE-${crypto.randomBytes(3).toString('hex')}`;

  assert.equal((await runHook('recall', { prompt: 'anything' }, env)).stdout, '', 'nothing retained yet: memoryless, and the 404 is not an error');
  const lines = [msg('user', 'u1', 'what is the secret code?', 1), msg('assistant', 'a1', `The secret code is ${token}.`, 2)];
  await stop(app, env, r.root, 'live.jsonl', lines);
  const doc = await waitFor(async () => (await hindsightApi(conn, 'GET', docUrl(bank, `cc-session:${LIVE_SESSION}`))).json?.original_text, { timeoutMs: 120_000, stepMs: 500 });
  assert.match(doc, new RegExp(token));
  const out = await waitFor(async () => { const x = await runHook('recall', { prompt: 'what is the secret code?' }, env); return x.stdout ? x : null; }, { timeoutMs: 120_000, stepMs: 1000 });
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, new RegExp(token));

  if (process.env.RUN_REAL_CLI === '1') {
    app.memory.resetContext(LIVE_SESSION);
    const answer = await new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', 'What is the secret code? Answer with only the code.', '--output-format', 'text', '--plugin-dir', path.join(REPO, 'claude')], { cwd: r.root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      child.stdout.on('data', (d) => { o += d; });
      child.on('error', reject);
      child.on('close', () => resolve(o));
      t.after(() => child.kill('SIGKILL'));
    });
    assert.match(answer, new RegExp(token), 'a real claude -p session answered from the recalled memory');
  }

  app.scopes.save([scope({ match: { ...match, stages: ['no-such-stage-xyz'] } })]);
  const x = await runHook('recall', { prompt: 'what is the secret code?' }, env);
  assert.deepEqual([x.code, x.stdout, x.stderr], [0, '', ''], 'a scope for another stage leaves the session memoryless');
});
