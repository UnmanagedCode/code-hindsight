// /-/hook/* and /-/mcp (src/hookRoutes.js): the non-browser request policy and the tool's
// enforcement of scopes, over the real memory.js with the fake cc and Hindsight; plus the
// /-/api/scopes round trip through the real app.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, mkRoot } from './helpers.mjs';
import { startFakeCc, live } from './support/fakeCc.mjs';
import { startFakeHindsight, FAKE_KEY } from './support/fakeHindsight.mjs';
import { createScopesStore, validateScopes } from '../src/scopes.js';
import { createCcClient } from '../src/ccSession.js';
import { createHindsightClient } from '../src/hindsightClient.js';
import { createRetainCursors } from '../src/retainCursor.js';
import { createActivityLog } from '../src/activity.js';
import { createMemory } from '../src/memory.js';
import { createHookRoutes, HOOK_BODY_LIMITS } from '../src/hookRoutes.js';

const JSON_CT = { 'content-type': 'application/json' };

async function setup(t, scopes = [{ name: 'a', match: {}, bank: 'cc-{project}', actions: ['recall', 'retain'] }]) {
  const r = mkRoot(t);
  const cc = await startFakeCc(t);
  const hs = await startFakeHindsight(t);
  const store = createScopesStore(r.dataDir);
  const v = validateScopes(scopes);
  assert.deepEqual(v.errors, []);
  store.save(v.scopes);
  const activity = createActivityLog({ dataDir: r.dataDir, log: () => {} });
  const memory = createMemory({
    scopes: store, cc: createCcClient({ conductorUrl: cc.url }),
    hindsight: createHindsightClient({ connection: () => ({ apiUrl: hs.url, apiKey: FAKE_KEY }) }),
    cursors: createRetainCursors(r.dataDir), activity,
  });
  const handle = createHookRoutes({ memory });
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.closeAllConnections(); server.close(); });
  cc.session('s1', live());
  /** A raw request, so the headers are exactly what the test names. */
  const send = (path, { method = 'POST', headers = JSON_CT, body = {} } = {}) => new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { ...headers, 'content-length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
  return { cc, hs, memory, send, activity };
}

test('a request that carries Origin or Sec-Fetch-Site/-Dest/-User is refused BROWSER_REFUSED on every route; Node fetch\'s own Sec-Fetch-Mode is not a browser', async (t) => {
  const x = await setup(t);
  const body = { sessionId: 's1', prompt: 'hi' };
  for (const h of [{ origin: 'http://evil.example' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-user': '?1' }]) {
    for (const path of ['/-/hook/recall', '/-/hook/retain', '/-/hook/reset', '/-/mcp']) {
      const r = await x.send(path, { headers: { ...JSON_CT, ...h }, body });
      assert.equal(r.status, 403, `${path} ${Object.keys(h)}`);
      assert.equal(r.body.code, 'BROWSER_REFUSED');
    }
  }
  assert.equal(x.cc.calls.length + x.hs.requests.length, 0, 'a refused request reached nothing');
  assert.equal((await x.send('/-/hook/recall', { headers: { ...JSON_CT, 'sec-fetch-mode': 'cors' }, body })).status, 200);
});

test('/-/mcp refuses a request that came through cc\'s public proxy (X-Forwarded-Prefix); the hook routes accept it', async (t) => {
  const x = await setup(t);
  const h = { ...JSON_CT, 'x-forwarded-prefix': '/plugins/code-hindsight' };
  assert.equal((await x.send('/-/mcp', { headers: h, body: { tool: 'recall', arguments: { query: 'q' }, caller: { sessionId: 's1' } } })).status, 403);
  assert.equal((await x.send('/-/hook/reset', { headers: h, body: { sessionId: 's1' } })).status, 200);
});

test('only POST with application/json, valid JSON, a session id and bounded bodies are accepted', async (t) => {
  const x = await setup(t);
  assert.equal((await x.send('/-/hook/recall', { method: 'GET', body: '' })).status, 405);
  assert.equal((await x.send('/-/hook/recall', { headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await x.send('/-/hook/recall', { body: '{nope' })).status, 400);
  assert.equal((await x.send('/-/hook/recall', { body: { sessionId: '../x', prompt: 'p' } })).status, 400);
  assert.equal((await x.send('/-/hook/recall', { body: { sessionId: 's1' } })).status, 400);
  assert.equal((await x.send('/-/hook/retain', { body: { sessionId: 's1', turns: [{ id: 1 }] } })).status, 400);
  assert.equal((await x.send('/-/hook/nope', { body: {} })).status, 404);
  for (const id of ['', 'x'.repeat(HOOK_BODY_LIMITS.other)]) {
    assert.equal((await x.send('/-/hook/retain', { body: { sessionId: 's1', turns: [{ id, role: 'user', content: 'q', timestamp: null }] } })).status, 400, 'an empty or oversized turn id is refused');
  }
  const big = (n) => ({ sessionId: 's1', prompt: 'x'.repeat(n) });
  assert.equal((await x.send('/-/hook/recall', { body: big(HOOK_BODY_LIMITS.other + 10) })).status, 413);
  const turns = [{ id: 'a', role: 'user', content: 'x'.repeat(HOOK_BODY_LIMITS.retain), timestamp: null }];
  assert.equal((await x.send('/-/hook/retain', { body: { sessionId: 's1', turns } })).status, 413);
  assert.equal(x.hs.requests.length, 0);
});

test('the hook routes answer: recall → {context}, retain → 202 and sends, reset → ok', async (t) => {
  const x = await setup(t);
  x.hs.bank('cc-proj', [{ id: 'm', text: 'a remembered thing' }]);
  const rec = await x.send('/-/hook/recall', { body: { sessionId: 's1', prompt: 'p' } });
  assert.match(rec.body.context, /a remembered thing/);
  assert.equal((await x.send('/-/hook/recall', { body: { sessionId: 's1', prompt: 'p' } })).body.context, null, 'flushed, so the memory now counts as injected');
  const turns = [{ id: 'u1', role: 'user', content: 'q', timestamp: '2026-01-01T00:00:00.000Z' }, { id: 'u2', role: 'assistant', content: 'a', timestamp: '2026-01-01T00:00:01.000Z' }];
  x.hs.retainLatency = 400;
  const t0 = Date.now();
  const ret = await x.send('/-/hook/retain', { body: { sessionId: 's1', turns } });
  assert.equal(ret.status, 202);
  assert.ok(Date.now() - t0 < 250, 'the 202 does not wait for Hindsight');
  await x.memory.idle();
  assert.ok(Date.now() - t0 >= 400, 'the send really was slow');
  x.hs.retainLatency = 0;
  assert.equal(x.hs.retains().length, 1);
  assert.equal((await x.send('/-/hook/reset', { body: { sessionId: 's1' } })).status, 200);
  assert.match((await x.send('/-/hook/recall', { body: { sessionId: 's1', prompt: 'p' } })).body.context, /a remembered thing/, 'reset makes the memory injectable again');
});

test('MCP enforcement: anonymous, retired and unscoped callers get an error; an allowed session reaches exactly its scopes\' banks, whatever the arguments say', async (t) => {
  const x = await setup(t, [{ name: 'p', match: { stages: ['plan'] }, bank: 'plan-{project}', actions: ['recall'] }]);
  x.hs.bank('plan-proj', [{ id: 'a', text: 'the planning note' }]);
  x.hs.bank('secret-bank', [{ id: 'z', text: 'not for you' }]);
  const call = (caller, args = { query: 'q' }, tool = 'recall') => x.send('/-/mcp', { body: { tool, arguments: args, caller, format: 'text' } });

  const anon = await call({});
  assert.deepEqual([anon.status, anon.body.code], [200, 'NO_SESSION']);
  assert.equal((await call(undefined)).body.code, 'NO_SESSION');
  x.cc.session('gone', 'retired');
  assert.equal((await call({ sessionId: 'gone' })).body.code, 'SESSION_NOT_LIVE');
  x.cc.session('s1', live({ stage: 'implement' }));
  assert.equal((await call({ sessionId: 's1' })).body.code, 'NO_RECALL_SCOPE');
  assert.equal(x.hs.requests.length, 0);

  x.cc.session('s1', live({ stage: 'plan' }));
  const ok = await call({ sessionId: 's1', project: 'secret' }, { query: 'q', bank: 'secret-bank', banks: ['secret-bank'], types: ['world'] });
  assert.match(ok.body.text, /the planning note/);
  assert.doesNotMatch(ok.body.text, /not for you/);
  assert.deepEqual(x.hs.recalls().map((r) => r.bank), ['plan-proj']);

  const unknown = await call({ sessionId: 's1' }, { query: 'q' }, 'forget');
  assert.deepEqual([unknown.status, typeof unknown.body.error], [200, 'string']);
  assert.equal((await call({ sessionId: 's1' }, { query: '' })).status, 200);
});

test('/-/api/scopes round trip: empty by default, SCOPES_INVALID names the field, a valid save is returned and kept', async (t) => {
  const { url } = await boot(t, { start: false });
  const h = { ...JSON_CT, 'sec-fetch-site': 'same-origin' };
  assert.deepEqual((await (await fetch(`${url}/-/api/scopes`)).json()).scopes, []);
  const bad = await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: h, body: JSON.stringify({ scopes: [{ name: 'x', match: { projects: [] }, bank: 'b-{nope}', actions: [] }] }) });
  assert.equal(bad.status, 400);
  const err = await bad.json();
  assert.equal(err.code, 'SCOPES_INVALID');
  assert.deepEqual(err.params.fields.map((f) => f.field).sort(), ['scopes[0].actions', 'scopes[0].bank', 'scopes[0].match.projects']);
  const good = [{ name: 'x', match: { stages: ['plan'] }, bank: 'cc-{project}', actions: ['recall'] }];
  const saved = await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: h, body: JSON.stringify({ scopes: good }) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await (await fetch(`${url}/-/api/scopes`)).json()).scopes, good);
  const cross = await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: { ...JSON_CT, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ scopes: [] }) });
  assert.equal(cross.status, 403, 'saving scopes keeps the /-/api cross-site rule');
});

test('/-/api/memory/stages lists cc\'s playbook stages and reports a failed read; the bank preview renders through scopes.js', async (t) => {
  const cc = await startFakeCc(t);
  const { url } = await boot(t, { start: false, cc: cc.url });
  const stages = await (await fetch(`${url}/-/api/memory/stages`)).json();
  assert.equal(stages.error, null);
  assert.deepEqual(stages.stages.find((s) => s.name === 'implement').playbooks, ['relay']);
  const h = { ...JSON_CT, 'sec-fetch-site': 'same-origin' };
  const prev = await fetch(`${url}/-/api/memory/preview-bank`, { method: 'POST', headers: h, body: JSON.stringify({ template: 'cc-{project}', sample: { project: '.Conduct' } }) });
  assert.equal((await prev.json()).bank, 'cc-conduct');
  const none = await boot(t, { start: false });
  const failed = await (await fetch(`${none.url}/-/api/memory/stages`)).json();
  assert.deepEqual(failed.stages, []);
  assert.ok(failed.error);
});

test('/-/api/memory/cc-projects lists cc\'s projects with their workspace and cc\'s workspaces; a failed read still answers 200 with an error', async (t) => {
  const cc = await startFakeCc(t, { projects: [{ name: 'proj', workspace: 'WS' }, { name: 'loner', workspace: null }] });
  const { url } = await boot(t, { start: false, cc: cc.url });
  const ok = await (await fetch(`${url}/-/api/memory/cc-projects`)).json();
  assert.deepEqual(ok, { projects: [{ name: 'loner', workspace: null }, { name: 'proj', workspace: 'WS' }], workspaces: [{ name: 'WS', projectCount: 1 }], error: null });
  cc.failWorkspaces(500);
  const half = await (await fetch(`${url}/-/api/memory/cc-projects`)).json();
  assert.equal(half.projects.length, 2);
  assert.deepEqual(half.workspaces, []);
  assert.match(half.error, /HTTP 500/);
  const none = await boot(t, { start: false });
  const res = await fetch(`${none.url}/-/api/memory/cc-projects`);
  assert.equal(res.status, 200);
  const failed = await res.json();
  assert.deepEqual([failed.projects, failed.workspaces], [[], []]);
  assert.equal(typeof failed.error, 'string');
});

test('/-/api/scopes refuses a bad workspaces entry by field, and round-trips a valid one', async (t) => {
  const { url } = await boot(t, { start: false });
  const h = { ...JSON_CT, 'sec-fetch-site': 'same-origin' };
  const bad = await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: h, body: JSON.stringify({ scopes: [{ name: 'x', match: { workspaces: ['a/b'] }, bank: 'b', actions: ['recall'] }] }) });
  assert.equal(bad.status, 400);
  const err = await bad.json();
  assert.equal(err.code, 'SCOPES_INVALID');
  assert.equal(err.params.fields[0].field, 'scopes[0].match.workspaces');
  const good = [{ name: 'x', match: { projects: ['code-*'], workspaces: ['CC-Dev', 'CC-*'] }, bank: 'cc-{project}', actions: ['recall', 'retain'] }];
  assert.equal((await fetch(`${url}/-/api/scopes`, { method: 'PUT', headers: h, body: JSON.stringify({ scopes: good }) })).status, 200);
  assert.deepEqual((await (await fetch(`${url}/-/api/scopes`)).json()).scopes, good);
});

test('a retain whose last turn has an empty id is refused and leaves the stored progress alone (no CURSOR_INVALID)', async (t) => {
  const x = await setup(t);
  const turn = (n, role) => ({ id: `u${n}`, role, content: `c${n}`, timestamp: `2026-01-01T00:00:0${n}.000Z` });
  await x.send('/-/hook/retain', { body: { sessionId: 's1', turns: [turn(1, 'user'), turn(2, 'assistant')] } });
  await x.memory.idle();
  const bad = await x.send('/-/hook/retain', { body: { sessionId: 's1', turns: [turn(1, 'user'), turn(2, 'assistant'), { id: '', role: 'assistant', content: 'x', timestamp: null }] } });
  assert.equal(bad.status, 400);
  await x.send('/-/hook/retain', { body: { sessionId: 's1', turns: [turn(1, 'user'), turn(2, 'assistant'), turn(3, 'user'), turn(4, 'assistant')] } });
  await x.memory.idle();
  assert.deepEqual(x.hs.retains().length, 2);
  assert.equal(x.activity.list().some((e) => e.code === 'CURSOR_INVALID'), false);
});
