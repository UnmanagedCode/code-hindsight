// The reverse path (Ollama and loopback cc backends) end to end without Docker: the real src/relay/relay.mjs as a local
// child process (port 0), the real tunnel and proxy, and fake upstreams (an Ollama daemon, an Anthropic-compatible endpoint). All local
// sockets; waits are the short ones injected through env and tunnel options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelayTunnel } from '../src/relayTunnel.js';
import { createRelayProxy } from '../src/relayProxy.js';
import { createOllamaDaemon } from '../src/ollamaDaemon.js';
import { startFakeOllama } from './support/fakeOllama.mjs';
import { startFakeAnthropic } from './support/fakeAnthropic.mjs';
import { RELAY_TARGETS } from '../src/pins.js';
import { waitFor } from './helpers.mjs';

const RELAY = fileURLToPath(new URL('../src/relay/relay.mjs', import.meta.url));
const KEY = 'k'.repeat(64);

async function startRelay(t, { key = KEY, waitMs = 300, handshakeMs = 200, env = {} } = {}) {
  const child = spawn(process.execPath, [RELAY], { env: { ...process.env, RELAY_KEY: key, RELAY_API_PORT: '0', RELAY_TUNNEL_PORT: '0', RELAY_WAIT_MS: String(waitMs), RELAY_HANDSHAKE_MS: String(handshakeMs), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const ports = await waitFor(() => { const m = /\{"listening":true.*\}/.exec(out); return m ? JSON.parse(m[0]) : null; });
  return { child, ...ports, log: () => out };
}

const ROW_TOKEN = 'row-token-sentinel';
const ROW_AUTH = Object.freeze({ header: 'authorization', value: `Bearer ${ROW_TOKEN}` });

/**
 * A relay with the plugin side attached: tunnel + proxy against a fake upstream. `kind` picks
 * the target: the Ollama daemon, or a loopback Anthropic-compatible endpoint (`rowPath`: the
 * base path of the row's URL; `auth`: how the row's token is injected).
 */
async function stack(t, { kind = 'ollama', ollama, anthropic, relay, tunnelOptions = {}, rowPath = '', auth = ROW_AUTH } = {}) {
  const fake = ollama ?? await startFakeOllama(t);
  const loop = anthropic ?? (kind === 'anthropic-loopback' ? await startFakeAnthropic(t) : null);
  const rl = relay ?? await startRelay(t);
  const proxy = createRelayProxy({ key: KEY, ollamaUrl: fake.url, daemon: createOllamaDaemon({ url: fake.url }) });
  proxy.setTarget(kind === 'ollama' ? { kind } : { kind, url: `${loop.url}${rowPath}`, auth });
  const tunnel = createRelayTunnel({ key: KEY, onSocket: proxy.handleSocket, idleTarget: 2, retryMs: 20, maxRetryMs: 100, ...tunnelOptions });
  tunnel.start({ host: '127.0.0.1', port: rl.tunnelPort });
  t.after(() => tunnel.stop());
  await waitFor(() => tunnel.status().idle >= 1);
  return { fake: kind === 'ollama' ? fake : loop, ollama: fake, anthropic: loop, rl, proxy, tunnel };
}

/** How the API's client presents the relay key for a target kind. */
const keyHeaders = (kind, key) => (!key ? {} : kind === 'ollama' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key });
const defaultPath = (kind) => (kind === 'ollama' ? '/v1/chat/completions' : '/v1/messages');

/** A request the way the API's client sends one: to the relay's API port, with the key. */
function call(port, { kind = 'ollama', path = defaultPath(kind), method = 'POST', key = KEY, body = '{"model":"m"}', headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...keyHeaders(kind, key), ...extra };
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
  const proxy = createRelayProxy({ key: KEY, ollamaUrl: fake.url, daemon: createOllamaDaemon({ url: fake.url }), clock: { now: () => now } });
  proxy.setTarget({ kind: 'ollama' });
  assert.equal(proxy.lastForward(), null);
  const first = await proxy.probeTarget();
  assert.deepEqual([first.ok, first.version], [true, '0.40.13']);
  await proxy.probeTarget();
  assert.equal(fake.requests.filter((r) => r.path === '/api/version').length, 1, 'cached');
  now += 60_000;
  fake.down = true;
  const down = await proxy.probeTarget();
  assert.equal(down.ok, false);
  assert.ok(down.error);
});

// OL8: after the relay restarts the tunnel reconnects by itself.
test('OL8: after a relay restart the tunnel reconnects', async (t) => {
  const fake = await startFakeOllama(t);
  const first = await startRelay(t);
  const proxy = createRelayProxy({ key: KEY, ollamaUrl: fake.url, daemon: createOllamaDaemon({ url: fake.url }) });
  proxy.setTarget({ kind: 'ollama' });
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

/** A hand-written request to the relay's API port: `line` is the whole request line, sent as is. */
function rawRequest(port, line, { key = KEY, kind = 'ollama' } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const keyLine = !key ? '' : kind === 'ollama' ? `Authorization: Bearer ${key}\r\n` : `X-Api-Key: ${key}\r\n`;
      s.write(`${line}\r\nHost: x\r\n${keyLine}Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
    });
    let text = '';
    s.on('data', (d) => { text += d; });
    s.on('error', () => {});
    s.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0), text }));
  });
}
const tunnelReady = (tunnel) => waitFor(() => tunnel.status().idle >= 1);

// LB-H (S-F1): a malformed request target can never throw out of the proxy: no key is 401, a key
// is 400, nothing is forwarded, and the same process serves the next request: on both targets.
for (const kind of Object.keys(RELAY_TARGETS)) {
  test(`LB-H S-F1 (${kind}): a malformed absolute-form target is 401 without the key and 400 with it, and the proxy keeps serving`, async (t) => {
    const { fake, rl, tunnel } = await stack(t, { kind });
    const path = defaultPath(kind);
    for (const target of ['http://', 'http://[::1/', 'http://x:99999999/', `http://x${path}`]) {
      await tunnelReady(tunnel);
      assert.equal((await rawRequest(rl.apiPort, `POST ${target} HTTP/1.1`, { key: null, kind })).status, 401, `${target} without a key`);
      await tunnelReady(tunnel);
      assert.equal((await rawRequest(rl.apiPort, `POST ${target} HTTP/1.1`, { kind })).status, 400, `${target} with a key`);
    }
    assert.equal(fake.requests.length, 0);
    await tunnelReady(tunnel);
    assert.equal((await call(rl.apiPort, { kind })).status, 200, 'the next request is served');
  });

  // LB-H (S-F3): what is allowlisted is exactly what is forwarded: only a normalised origin-form target passes.
  test(`LB-H S-F3 (${kind}): fragment, dot-segment and backslash targets are 400 and never forwarded`, async (t) => {
    const { fake, rl, tunnel } = await stack(t, { kind });
    const path = defaultPath(kind);
    for (const target of [`${path}#/../../api/pull`, `${path.slice(0, 4)}/../../api/pull`, `${path}\\..\\..\\api\\pull`, `//evil${path}`]) {
      await tunnelReady(tunnel);
      assert.equal((await rawRequest(rl.apiPort, `POST ${target} HTTP/1.1`, { kind })).status, 400, target);
    }
    assert.equal(fake.requests.length, 0);
  });

  test(`LB-H S-F3 (${kind}): the checked path and query are what is forwarded and what lastForward records`, async (t) => {
    const { fake, rl, proxy, tunnel } = await stack(t, { kind });
    await tunnelReady(tunnel);
    const target = `${kind === 'ollama' ? '/api/chat' : '/v1/messages'}?stream=true`;
    assert.equal((await rawRequest(rl.apiPort, `POST ${target} HTTP/1.1`, { kind })).status, 200);
    assert.equal(fake.requests.at(-1).path, target);
    assert.equal(proxy.lastForward().path, target);
  });
}

// OL8 (R2-S1): at the handshake cap the OLDEST silent socket is closed, so a valid connect always gets in.
test('OL8 R2-S1: at RELAY_MAX_HANDSHAKING the oldest silent socket is closed and a valid tunnel still authenticates', async (t) => {
  const rl = await startRelay(t, { handshakeMs: 5_000, env: { RELAY_MAX_HANDSHAKING: '2' } });
  const silent = () => new Promise((resolve) => {
    const s = net.connect(rl.tunnelPort, '127.0.0.1');
    s.on('error', () => {});
    s.on('connect', () => resolve(s));
  });
  const [a, b] = [await silent(), await silent()];
  const valid = net.connect(rl.tunnelPort, '127.0.0.1', () => valid.write(`HSR1 ${KEY}\n`));
  let go = null;
  valid.on('error', () => {});
  valid.on('data', (d) => { go = d; });
  t.after(() => [a, b, valid].forEach((x) => x.destroy()));
  await waitFor(() => a.destroyed);
  assert.equal(b.destroyed, false, 'only the oldest is closed');
  await new Promise((r) => setTimeout(r, 50));
  const api = net.connect(rl.apiPort, '127.0.0.1');
  api.on('error', () => {});
  t.after(() => api.destroy());
  await waitFor(() => go !== null);
  assert.deepEqual([...go], [1], 'the valid tunnel landed in idle and was paired');
});

// OL8 (R2-C1): at the waiting cap the OLDEST waiting API connection is closed and the newest is kept.
test('OL8 R2-C1: at RELAY_MAX_WAITING the oldest waiting API connection is closed', async (t) => {
  const rl = await startRelay(t, { waitMs: 3_000, env: { RELAY_MAX_WAITING: '1' } });
  const open = () => new Promise((resolve) => {
    const s = net.connect(rl.apiPort, '127.0.0.1');
    s.on('error', () => {});
    s.on('connect', () => resolve(s));
  });
  const [first, second] = [await open(), await open()];
  t.after(() => { first.destroy(); second.destroy(); });
  await waitFor(() => first.destroyed);
  assert.equal(second.destroyed, false);
});

// OL8 (R2-C1): parallel requests well above the old ceiling are each served; the plugin gives the relay a cap of LLM_MAX_CONCURRENT_MAX.
test('OL8 R2-C1: 128 parallel requests are each served (waiting cap sized to supported concurrency)', async (t) => {
  const { relaySpec } = await import('../src/containerSpec.js');
  const { resourceNames } = await import('../src/containerSpec.js');
  const { LLM_MAX_CONCURRENT_MAX } = await import('../src/settings.js');
  const spec = relaySpec({ names: resourceNames('p'), image: { id: 'sha256:x' }, bind: '127.0.0.1', port: 1, key: KEY, owner: 'o', target: RELAY_TARGETS.ollama });
  assert.equal(spec.env.RELAY_MAX_WAITING, String(LLM_MAX_CONCURRENT_MAX));
  const rl = await startRelay(t, { waitMs: 15_000, env: { RELAY_MAX_WAITING: spec.env.RELAY_MAX_WAITING } });
  const { fake } = await stack(t, { relay: rl });
  const results = await Promise.all(Array.from({ length: 128 }, (_, i) => call(rl.apiPort, { body: JSON.stringify({ n: i }) })));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
  assert.equal(fake.requests.length, 128);
});

// OL8 (S-F4): a flood of failed handshakes is one log line, not one per failure.
test('OL8 S-F4: repeated authentication failures collapse into one log line', async (t) => {
  const rl = await startRelay(t, { env: { RELAY_MAX_HANDSHAKING: '100' } });
  await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
    const s = net.connect(rl.tunnelPort, '127.0.0.1', () => s.write('HSR1 wrong\n'));
    s.on('error', () => {});
    s.on('close', resolve);
  })));
  assert.equal(rl.log().split('\n').filter((l) => /authentication failed/.test(l)).length, 1);
});

// OL8 (S-F8): a paired tunnel that never acks is dropped with its API connection, not held forever.
test('OL8 S-F8: a tunnel that does not ack after the go byte is closed along with the API connection', async (t) => {
  const rl = await startRelay(t, { env: { RELAY_ACK_MS: '150' } });
  const tunnel = net.connect(rl.tunnelPort, '127.0.0.1', () => tunnel.write(`HSR1 ${KEY}\n`));
  tunnel.on('error', () => {});
  let go = null;
  tunnel.once('data', (d) => { go = d; });
  await new Promise((r) => setTimeout(r, 50));
  const api = net.connect(rl.apiPort, '127.0.0.1');
  api.on('error', () => {});
  t.after(() => { tunnel.destroy(); api.destroy(); });
  await waitFor(() => go !== null);
  assert.deepEqual([...go], [1]);
  await waitFor(() => tunnel.destroyed && api.destroyed);
  assert.match(rl.log(), /did not ack/);
});

// N1: a cap below 1 is clamped, not a crash: the relay still pairs and serves a request.
test('OL8 N1: RELAY_MAX_WAITING=0 and RELAY_MAX_HANDSHAKING=0 are clamped and the relay still serves', async (t) => {
  const rl = await startRelay(t, { env: { RELAY_MAX_WAITING: '0', RELAY_MAX_HANDSHAKING: '0' } });
  const { fake } = await stack(t, { relay: rl });
  assert.equal((await call(rl.apiPort)).status, 200);
  assert.equal(fake.requests.length, 1);
  assert.equal(rl.child.exitCode, null, 'the relay is still running');
});

// LB4: on the anthropic target the relay key is checked on x-api-key; a Bearer key, a missing or a wrong key is 401.
test('LB4: on the anthropic-loopback target only an x-api-key relay key passes', async (t) => {
  const { fake, rl } = await stack(t, { kind: 'anthropic-loopback' });
  assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback' })).status, 200);
  const before = fake.requests.length;
  assert.equal((await call(rl.apiPort, { kind: 'ollama' })).status, 401, 'a Bearer relay key is not accepted here');
  for (const key of [null, 'wrong', `${KEY}x`]) assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback', key })).status, 401, String(key));
  assert.equal(fake.requests.length, before, 'nothing forwarded');
});

// LB5: the relay key never leaves; the row token is injected in the row's form; body, SDK headers and the base path survive.
test('LB5: the forwarded request carries the row token and not the relay key, with body, anthropic-version, base path and a streamed reply', async (t) => {
  const { fake, rl } = await stack(t, { kind: 'anthropic-loopback', rowPath: '/api/' });
  const body = JSON.stringify({ model: 'glm-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
  const res = await call(rl.apiPort, { kind: 'anthropic-loopback', body, headers: { 'anthropic-version': '2023-06-01', 'x-stainless-lang': 'python', authorization: 'Bearer client-sent' } });
  assert.equal(res.status, 200);
  assert.match(res.text, /message_start[\s\S]*message_stop/);
  const seen = fake.requests.at(-1);
  assert.equal(seen.path, '/api/v1/messages', 'the row base path prefixes the checked path');
  assert.equal(seen.headers.authorization, `Bearer ${ROW_TOKEN}`);
  assert.equal(seen.headers['x-api-key'], undefined, 'the relay key is in no header');
  assert.equal(seen.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.headers['x-stainless-lang'], 'python');
  assert.equal(seen.body, body);
  assert.ok(!JSON.stringify(seen.headers).includes(KEY));
});

// LB1b/LB5: an ANTHROPIC_API_KEY row is injected as x-api-key.
test('LB5: an x-api-key row token replaces the relay key in x-api-key and no Authorization is sent', async (t) => {
  const { fake, rl } = await stack(t, { kind: 'anthropic-loopback', auth: { header: 'x-api-key', value: ROW_TOKEN } });
  assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback' })).status, 200);
  const seen = fake.requests.at(-1);
  assert.equal(seen.headers['x-api-key'], ROW_TOKEN);
  assert.equal(seen.headers.authorization, undefined);
});

// LB6: only POST /v1/messages passes on the anthropic target.
test('LB6: count_tokens, model listing and a GET on /v1/messages are 403 and never forwarded', async (t) => {
  const { fake, rl } = await stack(t, { kind: 'anthropic-loopback' });
  for (const [method, path] of [['POST', '/v1/messages/count_tokens'], ['GET', '/v1/models'], ['GET', '/v1/messages'], ['POST', '/v1/messages/batches'], ['POST', '/v1/chat/completions']]) {
    assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback', method, path })).status, 403, `${method} ${path}`);
  }
  assert.equal(fake.requests.length, 0);
});

// LB7: a switch over a live tunnel redirects the next request; no target is 503.
test('LB7: setTarget switches ollama to anthropic-loopback over the same tunnel, and with no target requests are 503', async (t) => {
  const { ollama, rl, proxy, tunnel } = await stack(t);
  assert.equal((await call(rl.apiPort)).status, 200);
  const loop = await startFakeAnthropic(t);
  proxy.setTarget({ kind: 'anthropic-loopback', url: loop.url, auth: ROW_AUTH });
  await tunnelReady(tunnel);
  assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback' })).status, 200);
  assert.equal(loop.requests.length, 1);
  assert.equal(ollama.requests.filter((r) => r.method === 'POST').length, 1, 'the daemon saw only the first request');
  await tunnelReady(tunnel);
  assert.equal((await call(rl.apiPort, { kind: 'ollama' })).status, 401, 'the Ollama Bearer form is no longer the key');
  proxy.setTarget(null);
  await tunnelReady(tunnel);
  assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback' })).status, 503);
  assert.equal(loop.requests.length, 1, 'nothing forwarded without a target');
});

// LB8: an upstream outage is a 502 recorded as CC_BACKEND_UNREACHABLE; the probe treats any HTTP answer as up; neither holds the token.
test('LB8: an upstream outage is 502 recorded as CC_BACKEND_UNREACHABLE, and probeTarget counts a 404 as answering, caches and resets on setTarget', async (t) => {
  const { fake, rl, proxy } = await stack(t, { kind: 'anthropic-loopback' });
  fake.down = true;
  const res = await call(rl.apiPort, { kind: 'anthropic-loopback' });
  assert.equal(res.status, 502);
  assert.equal(proxy.lastForward().error, 'CC_BACKEND_UNREACHABLE');
  assert.ok(!res.text.includes(ROW_TOKEN) && !JSON.stringify(proxy.lastForward()).includes(ROW_TOKEN));
  fake.down = false;
  fake.notFound = true;
  let now = 1_000;
  const probing = createRelayProxy({ key: KEY, ollamaUrl: 'http://127.0.0.1:1', daemon: { version: async () => null }, clock: { now: () => now } });
  assert.equal(await probing.probeTarget(), null, 'no target, no probe');
  probing.setTarget({ kind: 'anthropic-loopback', url: fake.url, auth: ROW_AUTH });
  const first = await probing.probeTarget();
  assert.deepEqual([first.ok, first.version, first.error], [true, null, null]);
  const count = () => fake.requests.length;
  const n = count();
  await probing.probeTarget();
  assert.equal(count(), n, 'cached within the window');
  assert.equal(fake.requests.at(-1).headers.authorization, undefined, 'the probe sends no credentials');
  probing.setTarget({ kind: 'anthropic-loopback', url: fake.url, auth: ROW_AUTH });
  await probing.probeTarget();
  assert.equal(count(), n + 1, 'reset by setTarget');
  fake.down = true;
  now += 60_000;
  const down = await probing.probeTarget();
  assert.equal(down.ok, false);
  assert.ok(down.error);
  assert.ok(!JSON.stringify([first, down, probing.target()]).includes(ROW_TOKEN));
});

// LB7b: a request keeps the target it began with, even when setTarget runs while it is in flight.
test('LB7b: an in-flight request completes against its original upstream and token; the next request goes to the new target', async (t) => {
  let release;
  const held = new Promise((r) => { release = r; });
  const seenA = [];
  const slow = http.createServer((req, res) => {
    seenA.push(req.headers.authorization);
    req.resume();
    req.on('end', () => held.then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"from":"A"}'); }));
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  t.after(() => { release(); slow.closeAllConnections(); slow.close(); });
  const { rl, proxy, tunnel } = await stack(t, { kind: 'anthropic-loopback', anthropic: { url: `http://127.0.0.1:${slow.address().port}` }, auth: { header: 'authorization', value: 'Bearer token-A' } });
  const inflight = call(rl.apiPort, { kind: 'anthropic-loopback' });
  await waitFor(() => seenA.length === 1);
  const b = await startFakeAnthropic(t);
  proxy.setTarget({ kind: 'anthropic-loopback', url: b.url, auth: { header: 'authorization', value: 'Bearer token-B' } });
  assert.equal(b.requests.length, 0);
  release();
  const done = await inflight;
  assert.equal(done.status, 200);
  assert.match(done.text, /"from":"A"/);
  assert.deepEqual(seenA, ['Bearer token-A']);
  assert.equal(b.requests.length, 0, 'the new target saw nothing of the in-flight request');
  await tunnelReady(tunnel);
  assert.equal((await call(rl.apiPort, { kind: 'anthropic-loopback' })).status, 200);
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].headers.authorization, 'Bearer token-B');
});

// LB8c: a row URL with userinfo and a query probes fine, and the credential reaches no display, error or probe result.
test('LB8c: a userinfo/query row URL is probed and shown without its credential, and unknown target kinds are rejected', async (t) => {
  const fake = await startFakeAnthropic(t);
  const secretUrl = fake.url.replace('http://', 'http://user:pw-Zq81@') + '/base?key=pw-Zq81#frag';
  const proxy = createRelayProxy({ key: KEY, ollamaUrl: 'http://127.0.0.1:1', daemon: { version: async () => null } });
  proxy.setTarget({ kind: 'anthropic-loopback', url: secretUrl, auth: ROW_AUTH });
  assert.equal(proxy.target().url, `${fake.url}/base`);
  const up = await proxy.probeTarget();
  assert.equal(up.ok, true, JSON.stringify(up));
  fake.down = true;
  proxy.setTarget({ kind: 'anthropic-loopback', url: secretUrl, auth: ROW_AUTH });
  const down = await proxy.probeTarget();
  assert.equal(down.ok, false);
  assert.ok(!JSON.stringify([proxy.target(), up, down]).includes('pw-Zq81'));
  for (const kind of ['constructor', '__proto__', 'toString']) assert.throws(() => proxy.setTarget({ kind, url: fake.url }), /unknown relay target/, kind);
  // A forwarded call to the down upstream: the 502 body and lastForward hold no credential either.
  const rl = await startRelay(t);
  const tunnel = createRelayTunnel({ key: KEY, onSocket: proxy.handleSocket, idleTarget: 1, retryMs: 20, maxRetryMs: 100 });
  tunnel.start({ host: '127.0.0.1', port: rl.tunnelPort });
  t.after(() => tunnel.stop());
  await waitFor(() => tunnel.status().idle >= 1);
  const res = await call(rl.apiPort, { kind: 'anthropic-loopback' });
  assert.equal(res.status, 502);
  assert.ok(!res.text.includes('pw-Zq81') && !JSON.stringify(proxy.lastForward()).includes('pw-Zq81'));
});
