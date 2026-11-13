// claude/hooks/hook.mjs run as Claude Code runs it: a process fed the hook input on stdin. Pins that
// it can never block, fail or write anything it should not, whatever the backend does.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot } from './helpers.mjs';
import { runHook } from './support/runHook.mjs';

const TIMEOUT_MS = 400;
const run = runHook;

/** A backend answering every hook request with `reply(req, body)`; `requests` logs them. */
async function backend(t, reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: req.url, body });
    reply(req, res, body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const ok = (payload) => (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); };
const envFor = (url, extra = {}) => ({ CC_SESSION_ID: 'sess1', CODE_HINDSIGHT_HOOK_URL: url, CODE_HINDSIGHT_HOOK_TIMEOUT_MS: String(TIMEOUT_MS), ...extra });

function transcriptFile(t, lines) {
  const file = path.join(mkRoot(t).root, 't.jsonl');
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}
const msg = (type, uuid, text, ts) => ({ type, uuid, timestamp: ts, message: { role: type, content: text } });

test('recall prints exactly one valid hookSpecificOutput JSON carrying the backend\'s context, and posts the prompt without memory tags', async (t) => {
  const b = await backend(t, ok({ context: '<hindsight_memory>\nnote\n</hindsight_memory>' }));
  const r = await run('recall', { prompt: 'fix it <hindsight_memory>old</hindsight_memory>', session_id: 'backing-id' }, envFor(b.url));
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '<hindsight_memory>\nnote\n</hindsight_memory>' } });
  assert.deepEqual(b.requests, [{ url: '/-/hook/recall', body: { sessionId: 'sess1', prompt: 'fix it' } }], 'CC_SESSION_ID, not the backing session id, identifies the session');
});

test('recall prints nothing when the backend has no context', async (t) => {
  const b = await backend(t, ok({ context: null }));
  const r = await run('recall', { prompt: 'hi' }, envFor(b.url));
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
});

test('never blocks or fails: a hanging backend, a 500, a refused port and garbage all exit 0 inside the deadline with empty stdout and stderr', async (t) => {
  const hang = await backend(t, () => {});
  const boom = await backend(t, (_q, res) => { res.statusCode = 500; res.end('{"context":"must not be used"}'); });
  const garbage = await backend(t, (_q, res) => res.end('this is not json'));
  const closed = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(`http://127.0.0.1:${port}`)); }); });
  for (const [name, url] of [['hang', hang.url], ['500', boom.url], ['garbage', garbage.url], ['refused', closed]]) {
    for (const event of ['recall', 'retain', 'reset']) {
      const r = await run(event, { prompt: 'hi', transcript_path: transcriptFile(t, [msg('user', 'u1', 'q', '2026-01-01T00:00:00Z')]), last_assistant_message: '' }, envFor(url));
      assert.deepEqual([name, event, r.code, r.stdout, r.stderr], [name, event, 0, '', '']);
      assert.ok(r.ms < 5000, `${name}/${event} exited in ${r.ms} ms`);
    }
  }
});

test('garbage on stdin, no stdin at all and an unknown event are all silent exit 0', async (t) => {
  const b = await backend(t, ok({}));
  for (const stdin of ['not json', '', '[]']) {
    const r = await run('recall', null, envFor(b.url), { stdin });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  }
  const r = await run('bogus', {}, envFor(b.url));
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  assert.equal(b.requests.length, 0);
});

test('Stop prints nothing, ever, even when the backend answers with a context', async (t) => {
  const b = await backend(t, ok({ context: 'x', decision: 'block', additionalContext: 'y' }));
  const file = transcriptFile(t, [msg('user', 'u1', 'q', '2026-01-01T00:00:00Z'), msg('assistant', 'a1', 'the answer', '2026-01-01T00:00:01Z')]);
  const r = await run('retain', { transcript_path: file, last_assistant_message: 'the answer' }, envFor(b.url));
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  assert.equal(b.requests.length, 1);
});

test('outside a cc session (no CC_SESSION_ID, or no cc to reach) no request is made', async (t) => {
  const b = await backend(t, ok({ context: 'x' }));
  const none = await run('recall', { prompt: 'hi' }, { CODE_HINDSIGHT_HOOK_URL: b.url });
  assert.deepEqual([none.code, none.stdout], [0, '']);
  const noUrl = await run('recall', { prompt: 'hi' }, { CC_SESSION_ID: 'sess1' });
  assert.deepEqual([noUrl.code, noUrl.stdout, noUrl.stderr], [0, '', '']);
  assert.equal(b.requests.length, 0);
});

test('with CONDUCTOR_URL and no override, the hook goes through cc\'s plugin proxy path', async (t) => {
  const b = await backend(t, ok({ context: null }));
  await run('reset', {}, { CC_SESSION_ID: 'sess1', CONDUCTOR_URL: `${b.url}/` });
  assert.deepEqual(b.requests.map((r) => r.url), ['/plugins/code-hindsight/-/hook/reset']);
});

test('retain sends the transcript turns, and appends last_assistant_message as a synthetic turn when the transcript lacks it', async (t) => {
  const b = await backend(t, ok({}));
  const file = transcriptFile(t, [msg('user', 'u1', 'question', '2026-01-01T00:00:00Z'), msg('assistant', 'a0', 'earlier text', '2026-01-01T00:00:01Z')]);
  await run('retain', { transcript_path: file, last_assistant_message: 'the final words' }, envFor(b.url));
  const { turns } = b.requests[0].body;
  assert.deepEqual(turns.map((x) => [x.id, x.role, x.content]), [['u1', 'user', 'question'], ['a0', 'assistant', 'earlier text'], ['final:a0', 'assistant', 'the final words']]);
  assert.ok(turns.at(-1).timestamp);
});

test('retain does not duplicate the final message when the transcript already has it', async (t) => {
  const b = await backend(t, ok({}));
  const file = transcriptFile(t, [msg('user', 'u1', 'q', '2026-01-01T00:00:00Z'), msg('assistant', 'a1', 'the final words', '2026-01-01T00:00:01Z')]);
  await run('retain', { transcript_path: file, last_assistant_message: 'the final words' }, envFor(b.url));
  assert.deepEqual(b.requests[0].body.turns.map((x) => x.id), ['u1', 'a1']);
});
