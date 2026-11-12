// Reverse proxy from the plugin's mount to the Hindsight control plane (CP).
//
// cc strips `/plugins/code-hindsight` before a request reaches this backend; the CP was built
// with that base path, so it is put back on the way upstream. On the way down, CP redirects
// already carry the base path, and cc adds it again to every root-relative Location, so it is
// stripped here. The CP session cookie is added server-side and never reaches the browser.
import http from 'node:http';
import { BASE_PATH, CP_COOKIE } from './pins.js';
import { describeError } from './errors.js';
import { securityHeaders } from './http.js';

const CONNECT_TIMEOUT_MS = 10_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'host']);
const DROP_UPSTREAM = /^(x-forwarded-|forwarded$|x-real-ip$)/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A CP `Location` as cc expects to receive it: root-relative without the base path, or untouched. */
export function rewriteLocation(location, upstreamOrigin) {
  if (typeof location !== 'string') return location;
  let loc = location;
  if (upstreamOrigin && loc.startsWith(`${upstreamOrigin}/`)) loc = loc.slice(upstreamOrigin.length);
  else if (/^[a-z][a-z\d+\-.]*:/i.test(loc) || loc.startsWith('//')) return location;
  if (loc === BASE_PATH) return '/';
  if (loc.startsWith(`${BASE_PATH}/`) || loc.startsWith(`${BASE_PATH}?`)) {
    const rest = loc.slice(BASE_PATH.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  return loc;
}

/** The request's Cookie header without the CP cookie, plus ours. */
export function rewriteCookieHeader(header, token) {
  const parts = String(header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && p.split('=')[0].trim() !== CP_COOKIE);
  if (token) parts.push(`${CP_COOKIE}=${token}`);
  return parts.join('; ');
}

/** Response Set-Cookie lines without the CP cookie; the rest scoped to the mount instead of cc's whole origin. */
export function rewriteSetCookies(lines) {
  const out = [];
  for (const line of lines ?? []) {
    const name = /^\s*([^=;\s]+)=/.exec(line)?.[1];
    if (name === CP_COOKIE) continue;
    out.push(line.replace(/;\s*path=[^;]*/i, '').concat(`; Path=${BASE_PATH}`));
  }
  return out;
}

/** True for a request a cross-site page could have made: refuse it before injecting credentials. */
export function isCrossSite(req) {
  if (SAFE_METHODS.has(req.method)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site !== 'same-origin' && site !== 'none';
  return req.headers.origin !== undefined;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sendNotReady(res, error) {
  const e = error ?? describeError('NOT_READY');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hindsight is not running</title></head>`
    + `<body><h1>Hindsight is not running</h1><p><strong>${escapeHtml(e.title)}</strong></p><p>${escapeHtml(e.message)}</p>`
    + `<p>Open the Status tab of Code Hindsight to act on it.</p></body></html>`;
  res.writeHead(503, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** A same-site path to send /login to: its returnTo when that is a plain app path, else the dashboard. */
function afterLogin(search) {
  const back = new URLSearchParams(search).get('returnTo') ?? '';
  return back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/\\') && !back.startsWith('/login') ? back : '/dashboard';
}

const needsLogin = (up) => (up.statusCode === 401 && up.headers['x-hindsight-session-required'] !== undefined)
  || (up.statusCode >= 300 && up.statusCode < 400 && /\/login(?:[?#]|$)/.test(String(up.headers.location ?? '')));

/**
 * @param {object} o
 * @param {() => ({host: string, port: number} | null)} o.target the CP's address, or null while it is not ready
 * @param {{token(): Promise<string>, relogin(): Promise<string>}} o.session
 * @param {() => object | null} [o.notReadyError] the catalog error to show while there is no target
 */
export function createCpProxy({ target, session, notReadyError = () => null }) {
  return async function proxy(req, res) {
    const t = target();
    if (!t) return sendNotReady(res, notReadyError());
    if (isCrossSite(req)) return sendJson(res, 403, describeError('CROSS_SITE'));

    const q = req.url.indexOf('?');
    const pathname = q === -1 ? req.url : req.url.slice(0, q);
    const search = q === -1 ? '' : req.url.slice(q);
    // The backend owns the CP session: the CP's own sign-in and sign-out pages are bypassed.
    if (pathname === '/api/auth/logout') return sendJson(res, 200, { success: true });
    if (pathname === '/login') {
      res.writeHead(302, { ...securityHeaders(), location: afterLogin(search), 'cache-control': 'no-store' });
      return res.end();
    }

    const origin = `http://${t.host}:${t.port}`;
    const idempotent = req.method === 'GET' || req.method === 'HEAD';

    const send = (token, attempt) => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k) && !DROP_UPSTREAM.test(k) && k !== 'cookie') headers[k] = v;
      }
      headers.host = `${t.host}:${t.port}`;
      headers.cookie = rewriteCookieHeader(req.headers.cookie, token);

      const upReq = http.request({ host: t.host, port: t.port, method: req.method, path: `${BASE_PATH}${req.url}`, headers });
      let connectTimer = setTimeout(() => upReq.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      upReq.on('socket', (sock) => {
        if (!sock.connecting) { clearTimeout(connectTimer); connectTimer = null; } else sock.once('connect', () => { clearTimeout(connectTimer); connectTimer = null; });
      });
      res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });

      upReq.on('response', (up) => {
        if (connectTimer) clearTimeout(connectTimer);
        if (attempt === 0 && needsLogin(up)) {
          // The CP no longer accepts our session (expired, or the CP was recreated).
          if (idempotent) {
            up.resume();
            session.relogin().then((tok) => send(tok, 1), (e) => fail(e));
            return;
          }
          session.relogin().catch(() => {});
        }
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
        if (out.location) out.location = rewriteLocation(out.location, origin);
        if (out['set-cookie']) {
          const kept = rewriteSetCookies(out['set-cookie']);
          if (kept.length) out['set-cookie'] = kept; else delete out['set-cookie'];
        }
        res.writeHead(up.statusCode, out);
        up.pipe(res);
        up.on('error', () => res.destroy());
      });
      upReq.on('error', (e) => fail(e));
      if (idempotent || attempt > 0) upReq.end();
      else req.pipe(upReq);
    };

    const fail = (e) => {
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, 502, { ...describeError('NOT_READY'), detail: e?.message ?? String(e) });
    };

    let token;
    try {
      token = await session.token();
    } catch (e) {
      return fail(e);
    }
    send(token, 0);
  };
}
