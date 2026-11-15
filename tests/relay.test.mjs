// The Ollama reverse path end to end without Docker: the real src/relay/relay.mjs as a local
// child process (port 0), the real tunnel and proxy, and a fake Ollama daemon. All local
// sockets; waits are the short ones injected through env and tunnel options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelayTunnel } from '../src/relayTunnel.js';
import { createOllamaProxy } from '../src/ollamaProxy.js';
import { createOllamaDaemon } from '../src/ollamaDaemon.js';
import { startFakeOllama } from './support/fakeOllama.mjs';
import { waitFor } from './helpers.mjs';

const RELAY = fileURLToPath(new URL('../src/relay/relay.mjs', import.meta.url));
const KEY = 'k'.repeat(64);

async function startRelay(t, { key = KEY, waitMs = 300, handshakeMs = 200 } = {}) {
  const child = spawn(process.execPath, [RELAY], { env: { ...process.env, RELAY_KEY: key, RELAY_API_PORT: '0', RELAY_TUNNEL_PORT: '0', RELAY_WAIT_MS: String(waitMs), RELAY_HANDSHAKE_MS: String(handshakeMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const ports = await waitFor(() => { const m = /\{"listening":true.*\}/.exec(out); return m ? JSON.parse(m[0]) : null; });
  return { child, ...ports, log: () => out };
}

/** A relay with the plugin side attached: tunnel + proxy against the fake daemon. */
async function stack(t, { ollama, relay, tunnelOptions = {} } = {}) {
  const fake = ollama ?? await startFakeOllama(t);
  const rl = relay ?? await startRelay(t);
  const proxy = createOllamaProxy({ key: KEY, ollamaUrl: fake.url, daemon: createOllamaDaemon({ url: fake.url }) });
  const tunnel = createRelayTunnel({ key: KEY, onSocket: proxy.handleSocket, idleTarget: 2, retryMs: 20, maxRetryMs: 100, ...tunnelOptions });
  tunnel.start({ host: '127.0.0.1', port: rl.tunnelPort });
  t.after(() => tunnel.stop());
  await waitFor(() => tunnel.status().idle >= 1);
  return { fake, rl, proxy, tunnel };
}

/** A request the way the API's client sends one: to the relay's API port, with the key. */
function call(port, { path = '/v1/chat/completions', method = 'POST', key = KEY, body = '{"model":"m"}' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), chunks: chunks.length }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// OL8: a keyed chat request reaches the daemon intact, streamed, without the Authorization header.
test('OL8: a keyed chat request reaches the daemon intact and streamed, without Authorization', async (t) => {
  const { fake, rl } = await stack(t);
  const body = JSON.stringify({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }] });
  const chat = await call(rl.apiPort, { path: '/v1/chat/completions', body });
  assert.equal(chat.status, 200);
  assert.equal(JSON.parse(chat.text).echo, body);
  const native = await call(rl.apiPort, { path: '/api/chat', body });
  assert.equal(native.status, 200);
  assert.deepEqual(native.text.trim().split('\n').map((l) => JSON.parse(l).message.content), ['hel', 'lo']);
  assert.ok(native.chunks >= 1);
  const seen = fake.requests.filter((r) => r.method === 'POST');
  assert.deepEqual(seen.map((r) => r.path), ['/v1/chat/completions', '/api/chat']);
  for (const r of seen) { assert.equal(r.headers.authorization, undefined); assert.equal(r.body, body); }
});

// OL8: a missing or wrong key is 401 and nothing reaches the daemon.
test('OL8: a missing or wrong Bearer key is 401 and nothing is forwarded', async (t) => {
  const { fake, rl } = await stack(t);
  for (const key of [null, 'wrong', `${KEY}x`]) assert.equal((await call(rl.apiPort, { key })).status, 401, String(key));
  assert.equal(fake.requests.length, 0);
});

// OL8: only the two chat routes pass; model management is never reachable.
test('OL8: a non-allowlisted path or method is 403 and nothing is forwarded', async (t) => {
  const { fake, rl } = await stack(t);
  for (const [method, path] of [['POST', '/api/pull'], ['DELETE', '/api/delete'], ['POST', '/api/create'], ['GET', '/api/tags'], ['GET', '/v1/chat/completions']]) {
    assert.equal((await call(rl.apiPort, { method, path })).status, 403, `${method} ${path}`);
  }
  assert.equal(fake.requests.length, 0);
});

// OL8: a tunnel connection that does not present the key is closed and never serves a request.
test('OL8: a bad or missing handshake is closed', async (t) => {
  const rl = await startRelay(t);
  const closes = (write) => new Promise((resolve) => {
    const s = net.connect(rl.tunnelPort, '127.0.0.1', () => { if (write) s.write(write); });
    s.on('close', () => resolve(true));
    s.on('error', () => {});
    s.resume();
  });
  assert.equal(await closes('HSR1 wrong\n'), true);
  assert.equal(await closes('GET / HTTP/1.1\n'), true);
  assert.equal(await closes(null), true, 'silence times out');
  assert.equal(await closes('x'.repeat(400)), true, 'oversized');
  // Nothing authenticated: an API connection finds no tunnel.
  const r = await call(rl.apiPort).catch((e) => e);
  assert.ok(r instanceof Error);
  assert.match(rl.log(), /authentication failed/);
});

// OL8: with no tunnel the API connection is closed after the relay's wait, not left hanging.
test('OL8: with no tunnel an API connection is closed after RELAY_WAIT_MS', async (t) => {
  const rl = await startRelay(t, { waitMs: 150 });
  const started = Date.now();
  await assert.rejects(call(rl.apiPort), /socket hang up|ECONNRESET/);
  assert.ok(Date.now() - started >= 100);
  assert.match(rl.log(), /no tunnel/);
});

// OL8: a daemon outage is a 502 and is recorded as OLLAMA_UNREACHABLE for status.
test('OL8: a daemon outage is 502 and recorded as OLLAMA_UNREACHABLE', async (t) => {
  const { fake, rl, proxy } = await stack(t);
  fake.down = true;
  const res = await call(rl.apiPort);
  assert.equal(res.status, 502);
  assert.match(res.text, /did not answer/);
  assert.equal(proxy.lastForward().error, 'OLLAMA_UNREACHABLE');
  assert.equal(proxy.lastForward().path, '/v1/chat/completions');
  fake.down = false;
  assert.equal((await call(rl.apiPort)).status, 200, 'recovers without restarting anything');
});

// OL8: a keyed request that finds the daemon answering records its status.
test('OL8: the proxy records the last forward and probes the daemon once per cache window', async (t) => {
  const fake = await startFakeOllama(t);
  let now = 1_000;
  const proxy = createOllamaProxy({ key: KEY, ollamaUrl: fake.url, daemon: createOllamaDaemon({ url: fake.url }), clock: { now: () => now } });
  assert.equal(proxy.lastForward(), null);
  const first = await proxy.probeDaemon();
  assert.deepEqual([first.ok, first.version], [true, '0.40.13']);
  await proxy.probeDaemon();
  assert.equal(fake.requests.filter((r) => r.path === '/api/version').length, 1, 'cached');
  now += 60_000;
  fake.down = true;
  const down = await proxy.probeDaemon();
  assert.equal(down.ok, false);
  assert.ok(down.error);
});

// OL8: after the relay restarts the tunnel reconnects by itself.
test('OL8: after a relay restart the tunnel reconnects', async (t) => {
  const fake = await startFakeOllama(t);
  const first = await startRelay(t);
  const proxy = createOllamaProxy({ key: KEY, ollamaUrl: fake.url, daemon: createOllamaDaemon({ url: fake.url }) });
  const tunnel = createRelayTunnel({ key: KEY, onSocket: proxy.handleSocket, idleTarget: 2, retryMs: 20, maxRetryMs: 100 });
  t.after(() => tunnel.stop());
  tunnel.start({ host: '127.0.0.1', port: first.tunnelPort });
  await waitFor(() => tunnel.status().state === 'connected');
  first.child.kill('SIGKILL');
  await waitFor(() => tunnel.status().state === 'connecting');
  assert.ok(tunnel.status().error, 'the failure is reported');
  // A new relay on the same tunnel port.
  const again = spawn(process.execPath, [RELAY], { env: { ...process.env, RELAY_KEY: KEY, RELAY_API_PORT: '0', RELAY_TUNNEL_PORT: String(first.tunnelPort), RELAY_WAIT_MS: '300' }, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => again.kill('SIGKILL'));
  let out = '';
  again.stdout.on('data', (d) => { out += d; });
  const ports = await waitFor(() => { const m = /\{"listening":true.*\}/.exec(out); return m ? JSON.parse(m[0]) : null; });
  await waitFor(() => tunnel.status().state === 'connected');
  assert.equal((await call(ports.apiPort)).status, 200);
});

// OL8: parallel requests are each served: one tunnel connection per in-flight request, refilled as used.
test('OL8: N parallel requests are each served', async (t) => {
  const { fake, rl } = await stack(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call(rl.apiPort, { body: JSON.stringify({ n: i }) })));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  assert.deepEqual(results.map((r) => JSON.parse(JSON.parse(r.text).echo).n), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(fake.requests.length, 8);
});

test('OL8: stopping the tunnel closes its connections and reports stopped', async (t) => {
  const { tunnel } = await stack(t);
  assert.equal(tunnel.status().state, 'connected');
  tunnel.stop();
  assert.deepEqual(tunnel.status(), { state: 'stopped', idle: 0, error: null, address: null });
});
