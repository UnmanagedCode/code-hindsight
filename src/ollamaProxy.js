// What answers the API's Ollama calls on the plugin's side of the tunnel: an HTTP handler fed
// sockets from relayTunnel (the server never listens). It checks the relay key and a method +
// path allowlist, then streams the request to the Ollama daemon and the answer back.
import http from 'node:http';
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { OLLAMA_TARGET } from './pins.js';

export const OLLAMA_STATUS_CACHE_MS = 5_000;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const digest = (s) => crypto.createHash('sha256').update(s).digest();

/**
 * @param {object} o
 * @param {string} o.key the relay key every request must carry as a Bearer token
 * @param {string} o.ollamaUrl the daemon
 * @param {{version(): Promise<string|null>}} o.daemon
 * @param {{now(): number}} [o.clock]
 */
export function createOllamaProxy({ key, ollamaUrl, daemon, clock = { now: () => Date.now() } }) {
  const keyDigest = digest(key);
  const target = new URL(ollamaUrl);
  let lastForward = null;
  let probe = { at: -Infinity, value: null };

  const authorized = (header) => {
    const m = /^Bearer (.+)$/.exec(String(header ?? ''));
    return !!m && crypto.timingSafeEqual(digest(m[1]), keyDigest);
  };
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(body));
  };
  const record = (path, status, error = null) => { lastForward = { at: new Date(clock.now()).toISOString(), path, status, error }; };

  /**
   * The request target as `/path[?query]`, or null unless it is origin-form with a path that is
   * already normalised: what is allowlisted is exactly what is forwarded (no fragment, dot
   * segments, backslashes or absolute-form).
   */
  function checkedTarget(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('#')) return null;
    let url;
    try { url = new URL(raw, 'http://relay.local'); } catch { return null; }
    const rawPath = raw.split('?')[0];
    if (url.origin !== 'http://relay.local' || url.pathname !== rawPath) return null;
    return { path: url.pathname, forward: `${url.pathname}${url.search}` };
  }

  function handle(req, res) {
    req.on('error', () => {});
    res.on('error', () => {});
    // The key first: an unauthenticated caller learns nothing about what is parsed or allowed.
    if (!authorized(req.headers.authorization)) { req.resume(); return reply(res, 401, { error: 'unauthorized' }); }
    const t = checkedTarget(req.url);
    if (!t) { req.resume(); return reply(res, 400, { error: 'the request target must be an origin-form path' }); }
    if (!OLLAMA_TARGET.allowed.includes(`${req.method} ${t.path}`)) { req.resume(); return reply(res, 403, { error: 'this path is not relayed' }); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'authorization' && !HOP_BY_HOP.has(k)) headers[k] = v;
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: t.forward, headers, agent: false }, (ures) => {
      record(t.forward, ures.statusCode);
      const out = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
      res.writeHead(ures.statusCode, out);
      ures.pipe(res);
      ures.on('error', () => res.destroy());
    });
    upstream.on('error', (e) => {
      const err = new AppError('OLLAMA_UNREACHABLE', { url: ollamaUrl, detail: e.code ?? e.message });
      record(t.forward, res.headersSent ? null : 502, err.code);
      if (res.headersSent) res.destroy(); else reply(res, 502, { error: err.message });
    });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  // Nothing in a handler may throw out of the listener: that would end the plugin process.
  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      try { if (res.headersSent) res.destroy(); else { req.resume(); reply(res, 500, { error: 'internal error' }); } } catch { res.destroy(); }
      console.error(`code-hindsight: ollama proxy: ${e?.message ?? e}`);
    }
  });
  server.on('clientError', (_e, socket) => socket.destroy());

  return {
    /** Serve one tunnelled connection (it may carry several keep-alive requests). */
    handleSocket(socket) {
      socket.on('error', () => {});
      server.emit('connection', socket);
    },
    /** What the last forwarded request got: {at, path, status, error}, or null. */
    lastForward: () => lastForward,
    /** The daemon's answer to /api/version, cached for OLLAMA_STATUS_CACHE_MS: {ok, version, error, at}. */
    async probeDaemon() {
      if (clock.now() - probe.at < OLLAMA_STATUS_CACHE_MS) return probe.value;
      let value;
      try {
        value = { ok: true, version: await daemon.version(), error: null };
      } catch (e) {
        value = { ok: false, version: null, error: e?.params?.detail ?? e?.message ?? String(e) };
      }
      probe = { at: clock.now(), value: { ...value, at: new Date(clock.now()).toISOString() } };
      return probe.value;
    },
  };
}
