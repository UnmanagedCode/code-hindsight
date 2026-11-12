// The backend's HTTP surface (createApp): health independent of Hindsight, status with named
// errors, settings with write-only keys, the cross-site and content-type guards, jobs, bundles,
// the static UI and the security headers on every response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { boot, goodApiImage, goodCpImage, dockerCalls } from './helpers.mjs';
import { API_IMAGES, CP_IMAGE } from '../src/pins.js';
import { bundleName } from '../src/jobs.js';

const json = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const put = (url, body, headers = json) => fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
const post = (url, body = {}, headers = json) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

async function fakeCc(t, { autoStart = false } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/plugins/code-hindsight/status') return res.end(JSON.stringify({ id: 'code-hindsight', autoStart }));
    if (req.url === '/api/settings/models') {
      return res.end(JSON.stringify({ backends: [{ id: 'r', label: 'R', env: [{ key: 'ANTHROPIC_BASE_URL', value: 'https://x.example' }, { key: 'ANTHROPIC_AUTH_TOKEN', value: 'TOKEN-XYZ' }] }], backendModels: { r: [{ model: 'm', label: 'M' }] } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// Spec 1 + decision 1: health answers whatever Hindsight's state; the state and its code are in status.
test('health is 200 while docker is denied; status carries the named error and its action', async (t) => {
  const { url } = await boot(t, { mode: 'denied', sudoMode: 'password' });
  const h = await fetch(`${url}/-/api/health`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  const st = await (await fetch(`${url}/-/api/status`)).json();
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'DOCKER_DENIED');
  assert.equal(st.error.action, 'settings');
  assert.match(st.error.message, /password is required/);
});

test('status reports images, the Auto-start flag from cc, and refreshes on request', async (t) => {
  const cc = await fakeCc(t, { autoStart: false });
  const { url } = await boot(t, { seed: { images: {} }, cc });
  const st = await (await fetch(`${url}/-/api/status?refresh=1`)).json();
  assert.equal(st.error.code, 'IMAGE_MISSING');
  assert.equal(st.autoStart, false);
  assert.equal(st.images.api.present, false);
  assert.deepEqual(st.ports, { api: 18888, cp: 19999 });
  const noCc = await boot(t, { seed: { images: {} } });
  assert.equal('autoStart' in (await (await fetch(`${noCc.url}/-/api/status`)).json()), false, 'omitted when cc cannot be asked');
});

// Decision 15: keys never leave the backend; the UI sees hasKey booleans.
test('settings: keys are write-only and no route ever returns a key', async (t) => {
  const cc = await fakeCc(t);
  const { url, r, app } = await boot(t, { seed: { images: {} }, cc });
  const view = await (await fetch(`${url}/-/api/settings`)).json();
  assert.deepEqual(view.secrets, { llmApiKey: false, embeddingsApiKey: false });
  assert.equal(view.settings.llm.mode, 'none');

  const saved = await put(`${url}/-/api/settings`, { settings: { ...view.settings, llm: { mode: 'manual', provider: 'openai', model: 'gpt-x', baseUrl: null, backendId: null } }, secrets: { llmApiKey: 'sk-SECRET-LLM' } });
  assert.equal(saved.status, 200, await saved.clone().text());
  const after = await saved.json();
  assert.deepEqual(after.secrets, { llmApiKey: true, embeddingsApiKey: false });

  const secrets = app.secrets.get();
  const values = [secrets.apiKey, secrets.cpAccessKey, 'sk-SECRET-LLM', 'TOKEN-XYZ'];
  const bodies = [];
  for (const p of ['/-/api/settings', '/-/api/status', '/-/api/status?refresh=1', '/-/api/cc-backends', '/-/api/jobs']) bodies.push(await (await fetch(url + p)).text());
  for (const b of bodies) for (const v of values) assert.equal(b.includes(v), false, `a key leaked in ${b.slice(0, 80)}`);
  assert.ok(JSON.parse(bodies[3]).backends[0].usable);
  assert.equal(fs.readFileSync(path.join(r.dataDir, 'settings.json'), 'utf8').includes('sk-SECRET-LLM'), false);
});

// Spec 2: slim refusals surface by code on save.
test('saving slim with local embeddings is refused 400 with the named field codes', async (t) => {
  const { url } = await boot(t, { seed: { images: {} } });
  const view = await (await fetch(`${url}/-/api/settings`)).json();
  const res = await put(`${url}/-/api/settings`, { settings: { ...view.settings, variant: 'slim' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'SETTINGS_INVALID');
  assert.deepEqual(body.params.fields.map((f) => f.code).sort(), ['SLIM_NEEDS_REMOTE_EMBEDDINGS', 'SLIM_NEEDS_RERANKER']);
  const ok = await put(`${url}/-/api/settings`, { settings: { ...view.settings, variant: 'slim', embeddings: { provider: 'openai', model: 'e', baseUrl: null }, reranker: { provider: 'rrf' } }, secrets: { embeddingsApiKey: 'ek' } });
  assert.equal(ok.status, 200);
});

// Cross-site writes are refused on every state-changing route.
test('state-changing routes need JSON (415) and refuse cross-site requests (403)', async (t) => {
  const { url, r } = await boot(t, { seed: { images: {} } });
  const asForm = await fetch(`${url}/-/api/stop`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(asForm.status, 415);
  assert.match(asForm.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await post(`${url}/-/api/stop`, {}, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(`${url}/-/api/jobs/pull`, { variant: 'full' }, { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${url}/-/api/jobs/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'sec-fetch-site': 'cross-site' }, body: 'x' })).status, 403);
  assert.ok(!dockerCalls(r).some((a) => a[0] === 'pull' || a[0] === 'load'));
});

test('start, stop and restart drive the supervisor and answer with status', async (t) => {
  const { url } = await boot(t, { seed: { images: {} } });
  const stopped = await (await post(`${url}/-/api/stop`)).json();
  assert.equal(stopped.state, 'stopped');
  const started = await (await post(`${url}/-/api/start`)).json();
  assert.ok(['checking', 'starting', 'error'].includes(started.state));
});

// Spec 3: jobs over HTTP — pull, upload import, export and download.
test('jobs: pull, upload-import, export and bundle download', async (t) => {
  const { url, r } = await boot(t, { seed: { images: {} } });
  const started = await (await post(`${url}/-/api/jobs/pull`, { variant: 'full' })).json();
  assert.equal(started.kind, 'pull');
  let job;
  for (let i = 0; i < 100 && job?.state !== 'done'; i++) { job = await (await fetch(`${url}/-/api/jobs/${started.id}`)).json(); await new Promise((res) => setTimeout(res, 20)); }
  assert.equal(job.state, 'done');

  const upload = JSON.stringify({ images: { [CP_IMAGE]: goodCpImage(), [API_IMAGES.slim.ref]: goodApiImage('slim') } });
  const imp = await fetch(`${url}/-/api/jobs/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'sec-fetch-site': 'same-origin' }, body: upload });
  const impJob = await imp.json();
  assert.equal(impJob.state, 'done', JSON.stringify(impJob.error));
  assert.deepEqual(impJob.result.loaded.sort(), [API_IMAGES.slim.ref, CP_IMAGE].sort());

  const exp = await (await post(`${url}/-/api/jobs/export`, { variant: 'full' })).json();
  for (let i = 0; i < 100 && (await (await fetch(`${url}/-/api/jobs/${exp.id}`)).json()).state === 'running'; i++) await new Promise((res) => setTimeout(res, 20));
  const dl = await fetch(`${url}/-/api/bundles/${bundleName('full')}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await dl.text()).length, fs.statSync(path.join(r.dataDir, 'bundles', bundleName('full'))).size);
  assert.equal((await fetch(`${url}/-/api/bundles/..%2Fsecrets.json`)).status, 404);
  assert.equal((await fetch(`${url}/-/api/bundles/${bundleName('slim')}`)).status, 404);
});

test('a destructive job without its confirmation is refused 400', async (t) => {
  const { url } = await boot(t, { seed: { images: {} } });
  const res = await post(`${url}/-/api/jobs/delete-volume`, { confirm: 'oops' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'CONFIRMATION_REQUIRED');
});

test('container logs by role; unknown roles and routes are 404', async (t) => {
  const { url } = await boot(t, { seed: { images: {} } });
  assert.deepEqual(await (await fetch(`${url}/-/api/logs/api`)).json(), { role: 'api', log: 'log line for code-hindsight-api' });
  assert.equal((await fetch(`${url}/-/api/logs/postgres`)).status, 404);
  assert.equal((await fetch(`${url}/-/api/nope`)).status, 404);
  assert.equal((await fetch(`${url}/-/other`)).status, 404);
});

// Host contract: unbuilt UI → HTML entry 503, host URLs 404; built → allowlisted files only; CSP everywhere.
test('static UI: 503 while unbuilt, host URLs 404, allowlisted files only, CSP and nosniff on all', async (t) => {
  const unbuilt = await boot(t, { seed: { images: {} } });
  const root = await fetch(`${unbuilt.url}/`);
  assert.equal(root.status, 503);
  assert.match(await root.text(), /UI not built/);
  for (const p of ['/pluginBridge.js', '/pluginTheme.css']) {
    const res = await fetch(unbuilt.url + p);
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }

  const dist = fs.mkdtempSync(path.join(unbuilt.r.root, 'dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Code Hindsight</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbC.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbC.js.map'), '{}');
  const built = await boot(t, { seed: { images: {} }, distDir: dist });
  const page = await fetch(`${built.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-src 'self'/);
  assert.equal((await fetch(`${built.url}/assets/index-AbC.js`)).status, 200);
  for (const p of ['/assets/index-AbC.js.map', '/assets/index-AbC.js%2Emap', '/.vite/manifest.json']) {
    const res = await fetch(built.url + p);
    assert.notEqual(res.status, 200, p);
    assert.ok(res.headers.get('content-security-policy'), `${p} carries a CSP`);
  }
  // A CP path while Hindsight is not running is the not-ready page, not the shell.
  const cpPath = await fetch(`${built.url}/dashboard`);
  assert.equal(cpPath.status, 503);
  assert.match(await cpPath.text(), /not running/);
});
