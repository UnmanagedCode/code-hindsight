// Gated (RUN_REAL_DOCKER=1): the reverse path against the real Docker daemon. The API's
// own startup LLM check travels API container → relay container → plugin tunnel → a fake
// Ollama daemon, or a fake loopback Anthropic-compatible endpoint, in this process. Throwaway `code-hindsight-test-*` resources, removed afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootRealStack, hostDocker, realSkipReason } from './support/realStack.mjs';
import { startFakeOllama } from './support/fakeOllama.mjs';
import { startFakeAnthropic } from './support/fakeAnthropic.mjs';
import { waitFor } from './helpers.mjs';

const skip = realSkipReason('full') || false;

// OL11: the API's startup probe reaches a fake daemon through relay and tunnel; only the tunnel port is published.
test('OL11: real stack: the API\'s LLM check reaches the fake Ollama through the relay and tunnel', { skip, timeout: 15 * 60_000 }, async (t) => {
  const fake = await startFakeOllama(t);
  const cc = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ backends: [{ id: 'ollama', label: 'Ollama', template: 'ollama launch claude --model {model} --yes --', env: [], managed: true }], backendModels: { ollama: [{ model: 'qwen3:4b', label: 'Qwen' }] } }));
  });
  await new Promise((r) => cc.listen(0, '127.0.0.1', r));
  t.after(() => cc.close());

  const llm = { mode: 'cc-backend', provider: null, model: 'qwen3:4b', baseUrl: null, backendId: 'ollama', maxConcurrent: 1 };
  const { app, prefix, url } = await bootRealStack(t, { settings: { llm }, conductorUrl: `http://127.0.0.1:${cc.address().port}`, ollamaUrl: fake.url });
  await app.supervisor.ensureRunning();
  const st = app.supervisor.status();
  assert.equal(st.state, 'ready', JSON.stringify(st.error));
  assert.equal(st.relay.tunnel.state, 'connected');

  // The API's startup verification carries the configured model and no Authorization (the plugin strips it).
  const chat = await waitFor(() => fake.requests.find((r) => r.method === 'POST' && /^\/(v1\/chat\/completions|api\/chat)$/.test(r.path)), { timeoutMs: 120_000, stepMs: 500 });
  assert.match(chat.body, /qwen3:4b/);
  assert.equal(chat.headers.authorization, undefined);

  // S-F6: the API's own log (shown on Status) never holds the relay key it sent as a Bearer token.
  const apiLog = await (await fetch(`${url}/-/api/logs/api`)).text();
  assert.equal(apiLog.includes(app.secrets.get().relayKey), false, 'the relay key is not in the API log');

  // The address the relay sees for the plugin (decides whether a per-source cap could throttle the plugin itself).
  const relayLog = await (await fetch(`${url}/-/api/logs/relay`)).text();
  const seen = /tunnel authenticated from ([0-9a-f.:]+)/.exec(relayLog)?.[1];
  assert.ok(seen, `the relay logged the tunnel's source: ${relayLog.slice(-200)}`);
  console.log(`relay saw the plugin's tunnel from ${seen} (the plugin's bind address: ${app.supervisor.status().bindAddress})`);

  // Only the tunnel port is published, on the bind address; the API-facing port is not.
  const name = `${prefix}-relay`;
  const bindings = JSON.parse(hostDocker(['inspect', '-f', '{{json .HostConfig.PortBindings}}', name]).stdout);
  assert.deepEqual(Object.keys(bindings), ['7070/tcp']);
  assert.equal(bindings['7070/tcp'][0].HostPort, String(app.settings.get().network.relayPort));
  assert.equal(hostDocker(['inspect', '-f', '{{.Config.Image}}', name]).stdout.trim().startsWith('sha256:'), true, 'run by image ID');

  // Unlinking removes the relay.
  const s = app.settings.get();
  s.llm = { mode: 'none', provider: null, model: null, baseUrl: null, backendId: null, maxConcurrent: null };
  app.settings.save(s);
  await app.supervisor.ensureRunning();
  assert.equal(app.supervisor.status().relay, null);
  assert.notEqual(hostDocker(['inspect', name]).status, 0, 'the relay container is gone');
});

// LB16: a loopback cc backend row (loopback in this process's netns, standing in for cc's container) is served through the relay.
test('LB16: real stack: the API\'s startup LLM call reaches a loopback endpoint through relay and tunnel with the row token and not the relay key', { skip, timeout: 15 * 60_000 }, async (t) => {
  const fake = await startFakeAnthropic(t);
  const TOKEN = 'lb16-row-token-sentinel';
  const cc = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ backends: [{ id: 'opencode', label: 'OpenCode', template: 'claude', env: [{ key: 'ANTHROPIC_BASE_URL', value: fake.url }, { key: 'ANTHROPIC_AUTH_TOKEN', value: TOKEN }] }], backendModels: { opencode: [{ model: 'opencode-go/glm-5', label: 'GLM 5' }] } }));
  });
  await new Promise((r) => cc.listen(0, '127.0.0.1', r));
  t.after(() => cc.close());

  const llm = { mode: 'cc-backend', provider: null, model: 'opencode-go/glm-5', baseUrl: null, backendId: 'opencode', maxConcurrent: 1 };
  const { app, prefix } = await bootRealStack(t, { settings: { llm }, conductorUrl: `http://127.0.0.1:${cc.address().port}` });
  await app.supervisor.ensureRunning();
  const st = app.supervisor.status();
  assert.equal(st.state, 'ready', JSON.stringify(st.error));
  assert.equal(st.relay.target.kind, 'anthropic-loopback');

  const call = await waitFor(() => fake.requests.find((r) => r.method === 'POST' && r.path === '/v1/messages'), { timeoutMs: 120_000, stepMs: 500 });
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers['x-api-key'], undefined, 'the relay key is not forwarded');
  assert.match(call.body, /glm-5/);

  const alias = hostDocker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', `${prefix}-relay`]).stdout;
  assert.match(alias, /"cc-backend"/, 'the relay carries the cc-backend alias');
  for (const name of [`${prefix}-api`, `${prefix}-relay`]) {
    const env = hostDocker(['inspect', '-f', '{{json .Config.Env}}', name]).stdout;
    assert.equal(env.includes(TOKEN), false, `${name} env holds no row token`);
  }
});
