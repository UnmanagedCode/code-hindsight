// Gated (RUN_REAL_DOCKER=1): the Ollama reverse path against the real Docker daemon. The API's
// own startup LLM check travels API container → relay container → plugin tunnel → a fake
// Ollama daemon in this process. Throwaway `code-hindsight-test-*` resources, removed afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootRealStack, hostDocker, realSkipReason } from './support/realStack.mjs';
import { startFakeOllama } from './support/fakeOllama.mjs';
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
  const { app, prefix } = await bootRealStack(t, { settings: { llm }, conductorUrl: `http://127.0.0.1:${cc.address().port}`, ollamaUrl: fake.url });
  await app.supervisor.ensureRunning();
  const st = app.supervisor.status();
  assert.equal(st.state, 'ready', JSON.stringify(st.error));
  assert.equal(st.ollama.tunnel.state, 'connected');

  // The API's startup verification carries the configured model and no Authorization (the plugin strips it).
  const chat = await waitFor(() => fake.requests.find((r) => r.method === 'POST' && /^\/(v1\/chat\/completions|api\/chat)$/.test(r.path)), { timeoutMs: 120_000, stepMs: 500 });
  assert.match(chat.body, /qwen3:4b/);
  assert.equal(chat.headers.authorization, undefined);

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
  assert.equal(app.supervisor.status().ollama, null);
  assert.notEqual(hostDocker(['inspect', name]).status, 0, 'the relay container is gone');
});
