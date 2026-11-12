// Gated (RUN_REAL_DOCKER=1): the plugin against the real Docker daemon with the locally present
// pinned images. Throwaway `code-hindsight-test-*` resources, removed afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootRealStack, hindsightApi, hostDocker, realSkipReason } from './support/realStack.mjs';

const skip = realSkipReason('full') || false;

// Spec 1/4/5/8 end to end: start, keyed API, retain + recall, keyed CP behind the proxy, adoption, SIGTERM stop.
test('real stack: start, keys, retain/recall, CP through the proxy, adoption, SIGTERM stop', { skip, timeout: 15 * 60_000 }, async (t) => {
  const { app, url, prefix, again } = await bootRealStack(t);
  await app.supervisor.ensureRunning();
  const st = app.supervisor.status();
  assert.equal(st.state, 'ready', JSON.stringify(st.error));
  assert.ok(st.docker.mode, 'docker resolved');
  const conn = app.supervisor.connection();

  // The API refuses a request without its key.
  assert.equal((await hindsightApi(conn, 'GET', '/v1/default/banks', undefined, { key: null })).status, 401);
  assert.equal((await hindsightApi(conn, 'GET', '/v1/default/banks')).status, 200);

  // Retain and recall (LLM none: stored as chunks, recalled by embeddings).
  const bank = `real-${prefix.slice(-6)}`;
  assert.equal((await hindsightApi(conn, 'PUT', `/v1/default/banks/${bank}`, {})).status, 200);
  const retained = await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories`, { items: [{ content: 'The test harness parked the violet bicycle behind the library.' }] });
  assert.equal(retained.status, 200, retained.text);
  const recalled = await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories/recall`, { query: 'Where is the violet bicycle?' });
  assert.equal(recalled.status, 200, recalled.text);
  assert.match(JSON.stringify(recalled.json), /violet bicycle/);

  // The CP refuses requests without its session; through the plugin's proxy they work.
  const cpDirect = await fetch(`http://${st.bindAddress}:${st.ports.cp}/plugins/code-hindsight/api/banks`);
  assert.equal(cpDirect.status, 401);
  const viaProxy = await fetch(`${url}/api/banks`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(viaProxy.status, 200);
  assert.match(await viaProxy.text(), new RegExp(bank));

  // A second backend over the same data dir adopts the running containers.
  const ids = ['api', 'cp'].map((r) => hostDocker(['inspect', '-f', '{{.Id}}', `${prefix}-${r}`]).stdout.trim());
  const second = await again();
  await second.app.supervisor.ensureRunning();
  assert.equal(second.app.supervisor.status().state, 'ready');
  assert.deepEqual(['api', 'cp'].map((r) => hostDocker(['inspect', '-f', '{{.Id}}', `${prefix}-${r}`]).stdout.trim()), ids, 'same containers');

  // SIGTERM path: a detached `docker stop` stops both containers after the backend is gone.
  const pid = await second.app.supervisor.shutdown();
  assert.ok(pid);
  const deadline = Date.now() + 90_000;
  let states;
  do {
    await new Promise((r) => setTimeout(r, 1000));
    states = ['api', 'cp'].map((r) => hostDocker(['inspect', '-f', '{{.State.Status}}', `${prefix}-${r}`]).stdout.trim());
  } while (states.some((s) => s !== 'exited') && Date.now() < deadline);
  assert.deepEqual(states, ['exited', 'exited']);
  const volume = hostDocker(['volume', 'inspect', `${prefix}-data`]);
  assert.equal(volume.status, 0, 'the data volume is kept');
});

// Spec 2 (C4): the slim image with remote embeddings and the rrf reranker. Needs a real
// OpenAI-compatible embeddings key: CODE_HINDSIGHT_TEST_EMBEDDINGS_KEY (optionally
// CODE_HINDSIGHT_TEST_EMBEDDINGS_MODEL, CODE_HINDSIGHT_TEST_EMBEDDINGS_BASE_URL).
const embKey = process.env.CODE_HINDSIGHT_TEST_EMBEDDINGS_KEY;
const slimSkip = realSkipReason('slim') || (!embKey && 'set CODE_HINDSIGHT_TEST_EMBEDDINGS_KEY (an OpenAI-compatible embeddings key) to run the slim image') || false;

test('real slim stack: remote embeddings + rrf start healthy and recall', { skip: slimSkip, timeout: 15 * 60_000 }, async (t) => {
  const settings = {
    variant: 'slim',
    embeddings: { provider: 'openai', model: process.env.CODE_HINDSIGHT_TEST_EMBEDDINGS_MODEL || 'text-embedding-3-small', baseUrl: process.env.CODE_HINDSIGHT_TEST_EMBEDDINGS_BASE_URL || null },
    reranker: { provider: 'rrf' },
  };
  const { app, prefix } = await bootRealStack(t, { settings, secrets: { embeddingsApiKey: embKey } });
  await app.supervisor.ensureRunning();
  assert.equal(app.supervisor.status().state, 'ready', JSON.stringify(app.supervisor.status().error));
  const conn = app.supervisor.connection();
  const bank = `slim-${prefix.slice(-6)}`;
  assert.equal((await hindsightApi(conn, 'PUT', `/v1/default/banks/${bank}`, {})).status, 200);
  assert.equal((await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories`, { items: [{ content: 'The slim test stored a teal umbrella in the attic.' }] })).status, 200);
  const recalled = await hindsightApi(conn, 'POST', `/v1/default/banks/${bank}/memories/recall`, { query: 'Where is the teal umbrella?' });
  assert.equal(recalled.status, 200, recalled.text);
  assert.match(JSON.stringify(recalled.json), /teal umbrella/);
});
