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
  assert.deepEqual(await composeLlmEnv(DEFAULT_SETTINGS, {}, fromData(null)), { HINDSIGHT_API_LLM_PROVIDER: 'none' });
});

test('manual mode passes provider, model, base URL and the stored key', async () => {
  const env = await composeLlmEnv(llm({ mode: 'manual', provider: 'openai', model: 'gpt-x', baseUrl: 'https://api.example/v1' }), { llmApiKey: 'sk-1' }, fromData(null));
  assert.deepEqual(env, { HINDSIGHT_API_LLM_PROVIDER: 'openai', HINDSIGHT_API_LLM_MODEL: 'gpt-x', HINDSIGHT_API_LLM_BASE_URL: 'https://api.example/v1', HINDSIGHT_API_LLM_API_KEY: 'sk-1' });
  assert.deepEqual(await composeLlmEnv(llm({ mode: 'manual', provider: 'ollama', model: 'm' }), {}, fromData(null)), { HINDSIGHT_API_LLM_PROVIDER: 'ollama', HINDSIGHT_API_LLM_MODEL: 'm' });
});

// Spec 7: the live link maps a cc backend row onto Hindsight's anthropic provider, read from cc.
test('cc-backend reads cc\'s registry and maps the row to the anthropic provider', async (t) => {
  let hits = 0;
  const url = await fakeCc(t, (req, res) => { hits++; assert.equal(req.url, '/api/settings/models'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(MODELS)); });
  const env = await composeLlmEnv(llm({ mode: 'cc-backend', backendId: 'remote', model: 'glm-5' }), {}, { fetchCcModels: () => fetchCcModels(url) });
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
