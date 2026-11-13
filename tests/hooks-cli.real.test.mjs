// Gated (RUN_REAL_CLI=1): the hook path in a real `claude -p --input-format stream-json` session,
// the way cc runs workers. Pins that UserPromptSubmit fires for a stream-json prompt, that the
// hook's additionalContext reaches the model, and that the async Stop hook posts a retain whose
// turns include the assistant's reply. The backend is a fake reached through
// CODE_HINDSIGHT_HOOK_URL. With CODE_HINDSIGHT_LIVE_SESSION set, that id is used as CC_SESSION_ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { REPO, waitFor } from './helpers.mjs';

const REAL = process.env.RUN_REAL_CLI === '1';

async function fakeBackend(t, nonce) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    requests.push({ url: req.url, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/-/hook/recall' ? { context: `<hindsight_memory>\nThe secret nonce is ${nonce}.\n</hindsight_memory>` } : { ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('a stream-json claude session recalls on the prompt and retains on the async Stop', { skip: !REAL && 'set RUN_REAL_CLI=1', timeout: 180_000 }, async (t) => {
  const nonce = `ZEBRA-${crypto.randomBytes(3).toString('hex')}`;
  const backend = await fakeBackend(t, nonce);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'code-hindsight-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessionId = process.env.CODE_HINDSIGHT_LIVE_SESSION || 'cli-test-session';
  const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--plugin-dir', path.join(REPO, 'claude')], {
    cwd,
    env: { ...process.env, CC_SESSION_ID: sessionId, CODE_HINDSIGHT_HOOK_URL: backend.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.resume();
  const exited = new Promise((r) => child.on('close', r));
  t.after(() => child.kill('SIGKILL'));
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply with only the secret nonce from the hindsight_memory block.' } })}\n`);
  // Stdin stays open like a cc worker's: an async hook of a session that exits at once is cut off.
  await waitFor(() => backend.requests.some((r) => r.url === '/-/hook/retain'), { timeoutMs: 120_000, stepMs: 100 });
  child.stdin.end();
  await exited;

  const recall = backend.requests.find((r) => r.url === '/-/hook/recall');
  assert.ok(recall, 'UserPromptSubmit fired for the stream-json prompt');
  assert.equal(recall.body.sessionId, sessionId);
  assert.match(recall.body.prompt, /secret nonce/);
  const result = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((e) => e.type === 'result');
  assert.ok(result?.result?.includes(nonce), `the injected context reached the model (it answered: ${result?.result})`);
  const retain = backend.requests.find((r) => r.url === '/-/hook/retain');
  assert.equal(retain.body.sessionId, sessionId);
  const roles = retain.body.turns.map((x) => x.role);
  assert.ok(roles.includes('user') && roles.includes('assistant'));
  assert.ok(retain.body.turns.some((x) => x.role === 'assistant' && x.content.includes(nonce)), 'the retained turns include the assistant reply');
  assert.ok(!retain.body.turns.some((x) => x.content.includes('<hindsight_memory>')), 'injected memory is not retained');
});
