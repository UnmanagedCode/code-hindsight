// cpProxy.js + cpSession.js against a fake control plane, reached through the cc-style front
// (tests/support/ccFront.mjs): base path re-added upstream, Locations that land under the prefix
// exactly once, the CP cookie kept server-side, re-sign-in, CSRF refusal and the not-ready page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCpProxy, rewriteLocation, rewriteCookieHeader, rewriteSetCookies } from '../src/cpProxy.js';
import { createCpSession } from '../src/cpSession.js';
import { describeError } from '../src/errors.js';
import { startCcFront } from './support/ccFront.mjs';

const BP = '/plugins/code-hindsight';
const ACCESS = 'access-key';

async function fakeCp(t) {
  const valid = new Set();
  const seen = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const cookie = /hindsight_cp_access=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.url === `${BP}/api/auth/login`) {
      if (JSON.parse(body).key !== ACCESS) { res.writeHead(401); return res.end('{}'); }
      const tok = `tok${++n}`;
      valid.add(tok);
      res.writeHead(200, { 'set-cookie': `hindsight_cp_access=${tok}; Path=/; HttpOnly; SameSite=lax`, 'content-type': 'application/json' });
      return res.end('{"success":true}');
    }
    if (!valid.has(cookie)) {
      if (req.url.startsWith(`${BP}/api/`)) { res.writeHead(401, { 'x-hindsight-session-required': '1' }); return res.end('{"error":"Unauthorized"}'); }
      res.writeHead(307, { location: `${BP}/login?returnTo=${encodeURIComponent(req.url.slice(BP.length))}` });
      return res.end();
    }
    if (req.url === `${BP}/go-root`) { res.writeHead(307, { location: `${BP}/dashboard` }); return res.end(); }
    if (req.url === `${BP}/go-abs`) { res.writeHead(307, { location: `http://${req.headers.host}${BP}/banks/b1` }); return res.end(); }
    if (req.url === `${BP}/go-out`) { res.writeHead(302, { location: 'https://github.com/vectorize-io/hindsight' }); return res.end(); }
    if (req.url === `${BP}/cookies`) { res.writeHead(200, { 'set-cookie': ['hindsight_cp_access=leak; Path=/; HttpOnly', 'NEXT_LOCALE=en; Path=/; SameSite=lax'] }); return res.end('ok'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, valid, seen, expireAll: () => valid.clear() };
}

async function stack(t, { ready = true, error } = {}) {
  const cp = await fakeCp(t);
  const state = { ready };
  const target = () => (state.ready ? { host: '127.0.0.1', port: cp.port } : null);
  const session = createCpSession({ target: () => ({ host: '127.0.0.1', port: cp.port }), accessKey: () => ACCESS });
  let relogins = 0;
  const counted = { token: () => session.token(), relogin: () => { relogins++; return session.relogin(); } };
  const proxy = createCpProxy({ target, session: counted, notReadyError: () => error ?? null });
  const backend = http.createServer(proxy);
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const front = await startCcFront({ pluginId: 'code-hindsight', backendPort: backend.address().port });
  t.after(async () => { backend.closeAllConnections(); backend.close(); await front.close(); });
  const at = (p, init) => fetch(`${front.origin}${BP}${p}`, { redirect: 'manual', ...init });
  return { cp, front, at, state, relogins: () => relogins };
}

// Spec 6: the base path is put back upstream; the CP sees its own basePath URL and our cookie.
test('requests reach the CP under its base path with the server-side session cookie', async (t) => {
  const { cp, at } = await stack(t);
  const res = await at('/api/banks?limit=5', { headers: { cookie: 'hindsight_cp_access=from-browser; other=1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { method: 'GET', url: `${BP}/api/banks?limit=5`, body: '' });
  const req = cp.seen.at(-1);
  assert.match(req.headers.cookie, /^other=1; hindsight_cp_access=tok\d+$/);
  assert.equal(req.headers['x-forwarded-prefix'], undefined, 'cc\'s forwarding headers are not passed to the CP');
  assert.match(req.headers.host, /^127\.0\.0\.1:\d+$/);
});

// Spec 6 / cc fact: cc re-adds the prefix to every root-relative Location; ours must not double it.
test('CP redirects land under the prefix exactly once (root-relative and absolute)', async (t) => {
  const { at } = await stack(t);
  assert.equal((await at('/go-root')).headers.get('location'), `${BP}/dashboard`);
  assert.equal((await at('/go-abs')).headers.get('location'), `${BP}/banks/b1`);
  assert.equal((await at('/go-out')).headers.get('location'), 'https://github.com/vectorize-io/hindsight');
});

// Spec 5: the CP cookie never reaches the browser; other CP cookies are scoped to the mount.
test('the CP session cookie is stripped from responses; other cookies are scoped to the mount', async (t) => {
  const { at } = await stack(t);
  const res = await at('/cookies');
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.some((c) => c.startsWith('hindsight_cp_access')), false);
  assert.deepEqual(cookies, [`NEXT_LOCALE=en; SameSite=lax; Path=${BP}`]);
});

// Spec 5: auto-login — a rejected session is renewed and an idempotent request retried.
test('an expired session is renewed and GETs are retried (page redirect and API 401)', async (t) => {
  const { cp, at, relogins } = await stack(t);
  assert.equal((await at('/dashboard')).status, 200);
  cp.expireAll();
  const page = await at('/dashboard');
  assert.equal(page.status, 200, 'the login redirect never reaches the browser');
  assert.equal(relogins(), 1);
  cp.expireAll();
  const api = await at('/api/banks');
  assert.equal(api.status, 200);
  assert.equal(relogins(), 2);
});

test('a POST with an expired session is not replayed: it fails once, and the next works', async (t) => {
  const { cp, at } = await stack(t);
  await at('/api/x');
  cp.expireAll();
  const post = () => at('/api/memories/retain', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{"a":1}' });
  const first = await post();
  assert.equal(first.status, 401);
  await new Promise((r) => setTimeout(r, 50));
  const second = await post();
  assert.equal(second.status, 200);
  assert.equal((await second.json()).body, '{"a":1}', 'the body streams through');
});

test('the CP\'s sign-out is answered locally; /login goes back to the app', async (t) => {
  const { cp, at } = await stack(t);
  const out = await at('/api/auth/logout', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(out.status, 200);
  assert.equal(cp.seen.some((r) => r.url.endsWith('/api/auth/logout')), false);
  assert.equal((await at('/login?returnTo=%2Fbanks%2Fb1')).headers.get('location'), `${BP}/banks/b1`);
  assert.equal((await at('/login?returnTo=%2F%2Fevil.example')).headers.get('location'), `${BP}/dashboard`);
  assert.equal((await at('/login')).headers.get('location'), `${BP}/dashboard`);
});

// Credentials are injected server-side, so a cross-site write must be refused before it is forwarded.
test('state-changing requests from another site are refused 403 before reaching the CP', async (t) => {
  const { cp, at } = await stack(t);
  const before = cp.seen.length;
  assert.equal((await at('/api/banks/x', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await at('/api/banks/x', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(cp.seen.length, before);
  assert.equal((await at('/api/banks/x', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' })).status, 200);
});

test('while Hindsight is not ready, CP paths answer a 503 page with escaped error text and our CSP', async (t) => {
  const error = describeError('IMAGE_MISSING', { image: '<img src=x onerror=alert(1)>' });
  const { at } = await stack(t, { ready: false, error });
  const res = await at('/dashboard');
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await res.text();
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('rewrite helpers', () => {
  assert.equal(rewriteLocation(`${BP}/a?b=1`, 'http://h:1'), '/a?b=1');
  assert.equal(rewriteLocation(BP, 'http://h:1'), '/');
  assert.equal(rewriteLocation(`${BP}?x=1`, 'http://h:1'), '/?x=1');
  assert.equal(rewriteLocation('http://h:1/plugins/code-hindsight/x', 'http://h:1'), '/x');
  assert.equal(rewriteLocation('/other', 'http://h:1'), '/other');
  assert.equal(rewriteLocation('//evil.example/x', 'http://h:1'), '//evil.example/x');
  assert.equal(rewriteCookieHeader('', 't'), 'hindsight_cp_access=t');
  assert.equal(rewriteCookieHeader('a=1; hindsight_cp_access=old; b=2', 't'), 'a=1; b=2; hindsight_cp_access=t');
  assert.deepEqual(rewriteSetCookies(['x=1; path=/; HttpOnly']), [`x=1; HttpOnly; Path=${BP}`]);
});

test('a CP that refuses the access key is CP_LOGIN_FAILED', async (t) => {
  const cp = await fakeCp(t);
  const session = createCpSession({ target: () => ({ host: '127.0.0.1', port: cp.port }), accessKey: () => 'wrong' });
  await assert.rejects(session.token(), (e) => e.code === 'CP_LOGIN_FAILED' && /401/.test(e.message));
  const down = createCpSession({ target: () => ({ host: '127.0.0.1', port: 1 }), accessKey: () => ACCESS });
  await assert.rejects(down.token(), { code: 'CP_LOGIN_FAILED' });
});
