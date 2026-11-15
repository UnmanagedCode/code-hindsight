// llmEnv.js: the API container's LLM env in each mode, and the cc-backend live link read from a
// fake cc (GET /api/settings/models), with its named refusals and a token that never leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { composeLlmEnv, fetchCcModels, summarizeCcBackends, isLoopbackHost } from '../src/llmEnv.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const TOKEN = 'tok-SECRET-123';
const MODELS = {
  backends: [
    { id: 'claude', label: 'Claude', template: 'claude', env: [], managed: true },
    { id: 'remote', label: 'Remote proxy', template: 'anthropic', env: [{ key: 'ANTHROPIC_BASE_URL', value: 'https://llm.example.com/anthropic' }, { key: 'ANTHROPIC_AUTH_TOKEN', value: TOKEN }] },
    { id: 'local', label: 'Local proxy', template: 'anthropic', env: [{ key: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:18765' }, { key: 'ANTHROPIC_API_KEY', value: 'x' }] },
  ],
  backendModels: { remote: [{ model: 'glm-5', label: 'GLM 5' }], local: [{ model: 'qwen', label: 'Qwen' }] },
};

async function fakeCc(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const llm = (patch) => ({ ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, ...patch } });
const fromData = (data) => ({ fetchCcModels: async () => data });

// Spec 7: unset by default → Hindsight's chunks-only mode.
test('mode none sets provider none and nothing else', async () => {
  assert.deepEqual(await composeLlmEnv(DEFAULT_SETTINGS, {}, fromData(null)), { env: { HINDSIGHT_API_LLM_PROVIDER: 'none' }, relay: false });
});

test('manual mode passes provider, model, base URL and the stored key', async () => {
  const { env } = await composeLlmEnv(llm({ mode: 'manual', provider: 'openai', model: 'gpt-x', baseUrl: 'https://api.example/v1' }), { llmApiKey: 'sk-1' }, fromData(null));
  assert.deepEqual(env, { HINDSIGHT_API_LLM_PROVIDER: 'openai', HINDSIGHT_API_LLM_MODEL: 'gpt-x', HINDSIGHT_API_LLM_BASE_URL: 'https://api.example/v1', HINDSIGHT_API_LLM_API_KEY: 'sk-1' });
  assert.deepEqual(await composeLlmEnv(llm({ mode: 'manual', provider: 'ollama', model: 'm' }), {}, fromData(null)), { env: { HINDSIGHT_API_LLM_PROVIDER: 'ollama', HINDSIGHT_API_LLM_MODEL: 'm' }, relay: false });
});

// Spec 7: the live link maps a cc backend row onto Hindsight's anthropic provider, read from cc.
test('cc-backend reads cc\'s registry and maps the row to the anthropic provider', async (t) => {
  let hits = 0;
  const url = await fakeCc(t, (req, res) => { hits++; assert.equal(req.url, '/api/settings/models'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(MODELS)); });
  const { env } = await composeLlmEnv(llm({ mode: 'cc-backend', backendId: 'remote', model: 'glm-5' }), {}, { fetchCcModels: () => fetchCcModels(url) });
  assert.deepEqual(env, { HINDSIGHT_API_LLM_PROVIDER: 'anthropic', HINDSIGHT_API_LLM_MODEL: 'glm-5', HINDSIGHT_API_LLM_BASE_URL: 'https://llm.example.com/anthropic', HINDSIGHT_API_LLM_API_KEY: TOKEN });
  assert.equal(hits, 1);
});

test('cc-backend refusals are named: loopback, missing, unsupported, changed route, unreachable', async (t) => {
  const s = (backendId) => llm({ mode: 'cc-backend', backendId, model: 'm' });
  await assert.rejects(composeLlmEnv(s('local'), {}, fromData(MODELS)), (e) => e.code === 'CC_BACKEND_LOOPBACK' && e.params.host === '127.0.0.1');
  await assert.rejects(composeLlmEnv(s('gone'), {}, fromData(MODELS)), (e) => e.code === 'CC_BACKEND_MISSING' && e.params.backendId === 'gone');
  await assert.rejects(composeLlmEnv(s('claude'), {}, fromData(MODELS)), { code: 'CC_BACKEND_UNSUPPORTED' });
  await assert.rejects(composeLlmEnv(s('remote'), {}, fromData({ rows: [] })), { code: 'CC_ROUTE_CHANGED' });
  await assert.rejects(composeLlmEnv(s('remote'), {}, fromData({ backends: [{ id: 'remote', env: 'nope' }] })), { code: 'CC_ROUTE_CHANGED' });

  const down = await fakeCc(t, (_req, res) => { res.statusCode = 500; res.end(); });
  await assert.rejects(fetchCcModels(down), { code: 'CC_UNREACHABLE' });
  await assert.rejects(fetchCcModels('http://127.0.0.1:1'), { code: 'CC_UNREACHABLE' });
  await assert.rejects(fetchCcModels(null), { code: 'CC_UNREACHABLE' });
  const notJson = await fakeCc(t, (_req, res) => res.end('<html>'));
  await assert.rejects(fetchCcModels(notJson), { code: 'CC_ROUTE_CHANGED' });
});

// Spec 7: the picker sees ids, labels, hosts and model names — never a token or the raw env.
test('the backend summary carries no token and flags unusable rows with their reason', () => {
  const list = summarizeCcBackends(MODELS);
  assert.equal(JSON.stringify(list).includes(TOKEN), false);
  assert.equal(JSON.stringify(list).includes('ANTHROPIC'), false);
  assert.deepEqual(list.map((b) => [b.id, b.usable, b.refusal, b.host]), [
    ['claude', false, 'CC_BACKEND_UNSUPPORTED', null],
    ['remote', true, null, 'llm.example.com'],
    ['local', false, 'CC_BACKEND_LOOPBACK', '127.0.0.1'],
  ]);
  assert.deepEqual(list[1].models, [{ model: 'glm-5', label: 'GLM 5' }]);
});

// S6: best-effort over literal addresses and localhost, after WHATWG URL normalization.
test('loopback detection covers 127/8 in every literal spelling, localhost, ::1 and IPv4-mapped IPv6', () => {
  const host = (u) => new URL(u).hostname;
  for (const u of ['http://127.0.0.1', 'http://127.9.9.9', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://localhost', 'http://LOCALHOST', 'http://localhost.', 'http://api.localhost', 'http://0.0.0.0', 'http://0',
    'http://[::1]', 'http://[0:0:0:0:0:0:0:1]', 'http://[::]', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:2]', 'http://[::127.0.0.1]']) {
    assert.equal(isLoopbackHost(host(u)), true, u);
  }
  for (const u of ['http://172.20.0.1', 'http://example.com', 'http://10.0.0.1', 'http://[2001:db8::1]', 'http://[::ffff:10.0.0.1]', 'http://128.0.0.1']) {
    assert.equal(isLoopbackHost(host(u)), false, u);
  }
});

test('a cc backend on an obfuscated loopback URL is refused CC_BACKEND_LOOPBACK', async () => {
  for (const base of ['http://127.1:18765', 'http://[::ffff:127.0.0.1]:18765', 'http://2130706433/x']) {
    const data = { backends: [{ id: 'b', env: [{ key: 'ANTHROPIC_BASE_URL', value: base }, { key: 'ANTHROPIC_AUTH_TOKEN', value: 't' }] }] };
    await assert.rejects(composeLlmEnv(llm({ mode: 'cc-backend', backendId: 'b', model: 'm' }), {}, fromData(data)), { code: 'CC_BACKEND_LOOPBACK' }, base);
  }
});

const OLLAMA_DATA = {
  backends: [
    { id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true },
    // Detected by what it launches, not by its id.
    { id: 'my-local-llm', label: 'Mine', template: '  ollama run {model}', env: [] },
    { id: 'claude', label: 'Claude', template: 'claude', env: [] },
  ],
  backendModels: { ollama: [{ model: 'glm-5.3:cloud', label: 'GLM' }, { model: 'qwen3:4b', label: 'Qwen 4B' }, { model: 'deepseek:1017-cloud', label: 'DS' }] },
};

// OL1: the Ollama link env points the API's ollama provider at the relay, carrying the relay key.
test('OL1: an Ollama cc-backend maps to provider ollama at the relay with the relay key as its API key', async () => {
  const { env, relay } = await composeLlmEnv(llm({ mode: 'cc-backend', backendId: 'ollama', model: 'qwen3:4b' }), { relayKey: 'rk', llmApiKey: 'not-this' }, fromData(OLLAMA_DATA));
  assert.equal(relay, true);
  assert.deepEqual(env, { HINDSIGHT_API_LLM_PROVIDER: 'ollama', HINDSIGHT_API_LLM_MODEL: 'qwen3:4b', HINDSIGHT_API_LLM_BASE_URL: 'http://ollama:11434/v1', HINDSIGHT_API_LLM_API_KEY: 'rk' });
});

// OL2: an Ollama row is recognised by its template, not its id; an unrelated row is still refused.
test('OL2: a row is an Ollama row by its template, whatever its id', async () => {
  const kinds = summarizeCcBackends(OLLAMA_DATA).map((b) => [b.id, b.kind, b.usable]);
  assert.deepEqual(kinds, [['ollama', 'ollama', true], ['my-local-llm', 'ollama', true], ['claude', null, false]]);
  const { relay } = await composeLlmEnv(llm({ mode: 'cc-backend', backendId: 'my-local-llm', model: 'm' }), { relayKey: 'rk' }, fromData(OLLAMA_DATA));
  assert.equal(relay, true);
  await assert.rejects(composeLlmEnv(llm({ mode: 'cc-backend', backendId: 'claude', model: 'm' }), {}, fromData(OLLAMA_DATA)), { code: 'CC_BACKEND_UNSUPPORTED' });
});

// OL3: max parallel requests reaches every non-none mode when set, and is absent when null.
test('OL3: maxConcurrent is emitted in manual, anthropic and ollama modes only when set', async () => {
  const MAX = 'HINDSIGHT_API_LLM_MAX_CONCURRENT';
  const manual = { mode: 'manual', provider: 'openai', model: 'm' };
  assert.equal((await composeLlmEnv(llm({ ...manual, maxConcurrent: 3 }), {}, fromData(null))).env[MAX], '3');
  assert.equal(MAX in (await composeLlmEnv(llm(manual), {}, fromData(null))).env, false);
  const cc = { mode: 'cc-backend', model: 'm', maxConcurrent: 1 };
  assert.equal((await composeLlmEnv(llm({ ...cc, backendId: 'ollama' }), { relayKey: 'k' }, fromData(OLLAMA_DATA))).env[MAX], '1');
  assert.equal((await composeLlmEnv(llm({ ...cc, backendId: 'remote' }), {}, fromData(MODELS))).env[MAX], '1');
  assert.equal(MAX in (await composeLlmEnv(llm({ ...cc, maxConcurrent: null, backendId: 'remote' }), {}, fromData(MODELS))).env, false);
  assert.equal(MAX in (await composeLlmEnv(llm({ maxConcurrent: 5 }), {}, fromData(null))).env, false, 'none mode has no LLM to cap');
});

// OL6: the picker merges cc's models with the daemon's; cloud is false only for a daemon tag without remote_host.
test('OL6: Ollama models are cc\'s first, then the daemon\'s; only a plain tag is local', () => {
  const daemon = { reachable: true, version: '0.40.13', error: null, tags: [{ model: 'qwen3:4b', cloud: false }, { model: 'qwen2.5-coder:3b', cloud: false }, { model: 'kimi:cloud', cloud: true }] };
  const row = summarizeCcBackends(OLLAMA_DATA, daemon)[0];
  assert.deepEqual(row.daemon, { reachable: true, version: '0.40.13', error: null });
  assert.deepEqual(row.models.map((m) => [m.model, m.source, m.cloud]), [
    ['glm-5.3:cloud', 'cc', true], ['qwen3:4b', 'cc', false], ['deepseek:1017-cloud', 'cc', true],
    ['qwen2.5-coder:3b', 'daemon', false], ['kimi:cloud', 'daemon', true],
  ]);
  assert.equal(row.models[1].label, 'Qwen 4B');
});

test('OL6: an unreachable daemon gives reachable:false and every cc model counts as cloud', () => {
  const row = summarizeCcBackends(OLLAMA_DATA, { reachable: false, version: null, error: 'ECONNREFUSED', tags: [] })[0];
  assert.deepEqual(row.daemon, { reachable: false, version: null, error: 'ECONNREFUSED' });
  assert.deepEqual(row.models.map((m) => m.cloud), [true, true, true]);
  assert.equal(summarizeCcBackends(OLLAMA_DATA)[0].daemon.reachable, false, 'no daemon info is unreachable');
});
