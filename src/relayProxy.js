// What answers the API's LLM calls on the plugin's side of the tunnel: an HTTP handler fed
// sockets from relayTunnel (the server never listens). For the active target it checks the relay
// key and a method + path allowlist, swaps in the real upstream credentials where the target has
// any, then streams the request to the target and the answer back.
import http from 'node:http';
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { RELAY_TARGETS } from './pins.js';

export const RELAY_PROBE_CACHE_MS = 5_000;
export const RELAY_PROBE_TIMEOUT_MS = 3_000;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const digest = (s) => crypto.createHash('sha256').update(s).digest();

/**
 * @param {object} o
 * @param {string} o.key the relay key every request must carry (in the target's `keyHeader`)
 * @param {string} o.ollamaUrl the Ollama daemon
 * @param {{version(): Promise<string|null>}} o.daemon
 * @param {{now(): number}} [o.clock]
 * @param {typeof fetch} [o.fetchImpl] the loopback target's reachability probe
 */
export function createRelayProxy({ key, ollamaUrl, daemon, clock = { now: () => Date.now() }, fetchImpl = fetch }) {
  const keyDigest = digest(key);
  /** The active target: `{kind, url, auth, allowed, keyHeader}` (auth is held here and nowhere else), or null. */
  let active = null;
  let lastForward = null;
  let probe = { at: -Infinity, value: null };

  /** @param {{kind: string, url?: string, auth?: {header: string, value: string}}|null} t */
  function setTarget(t) {
    probe = { at: -Infinity, value: null };
    if (!t) { active = null; return; }
    const spec = RELAY_TARGETS[t.kind];
    if (!spec) throw new Error(`unknown relay target kind: ${t.kind}`);
    const url = t.kind === 'ollama' ? ollamaUrl : t.url;
    active = { kind: t.kind, url, parsed: new URL(url), auth: t.auth ?? null, allowed: spec.allowed, keyHeader: spec.keyHeader };
  }

  const authorized = (t, headers) => {
    const raw = headers[t.keyHeader];
    let candidate;
    if (t.keyHeader === 'authorization') candidate = /^Bearer (.+)$/.exec(String(raw ?? ''))?.[1];
    else candidate = typeof raw === 'string' && raw ? raw : undefined;
    return candidate !== undefined && crypto.timingSafeEqual(digest(candidate), keyDigest);
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
    // The target is read once, when the request arrives: a later switch does not move it.
    const t = active;
    if (!t) { req.resume(); return reply(res, 503, { error: 'no relay target' }); }
    // The key first: an unauthenticated caller learns nothing about what is parsed or allowed.
    if (!authorized(t, req.headers)) { req.resume(); return reply(res, 401, { error: 'unauthorized' }); }
    const c = checkedTarget(req.url);
    if (!c) { req.resume(); return reply(res, 400, { error: 'the request target must be an origin-form path' }); }
    if (!t.allowed.includes(`${req.method} ${c.path}`)) { req.resume(); return reply(res, 403, { error: 'this path is not relayed' }); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'authorization' && k !== 'x-api-key' && !HOP_BY_HOP.has(k)) headers[k] = v;
    if (t.auth) headers[t.auth.header] = t.auth.value;
    // A row base with a path keeps it, as the SDK would build the URL directly.
    const prefix = t.kind === 'anthropic-loopback' ? t.parsed.pathname.replace(/\/+$/, '') : '';
    const forward = `${prefix}${c.forward}`;
    const hostname = t.parsed.hostname.replace(/^\[|\]$/g, '');
    const upstream = http.request({ hostname, port: t.parsed.port, method: req.method, path: forward, headers, agent: false }, (ures) => {
      record(c.forward, ures.statusCode);
      const out = {};
      for (const [k, v] of Object.entries(ures.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
      res.writeHead(ures.statusCode, out);
      ures.pipe(res);
      ures.on('error', () => res.destroy());
    });
    upstream.on('error', (e) => {
      const err = new AppError(t.kind === 'ollama' ? 'OLLAMA_UNREACHABLE' : 'CC_BACKEND_UNREACHABLE', { url: t.url, detail: e.code ?? e.message });
      record(c.forward, res.headersSent ? null : 502, err.code);
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
      console.error(`code-hindsight: relay proxy: ${e?.message ?? e}`);
    }
  });
  server.on('clientError', (_e, socket) => socket.destroy());

  async function probeNow(t) {
    if (t.kind === 'ollama') return { ok: true, version: await daemon.version(), error: null };
    // Any HTTP answer, a 404 included, shows something listens. No credentials are sent.
    await fetchImpl(t.url, { redirect: 'manual', signal: AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS) });
    return { ok: true, version: null, error: null };
  }

  return {
    /** Serve one tunnelled connection (it may carry several keep-alive requests). */
    handleSocket(socket) {
      socket.on('error', () => {});
      server.emit('connection', socket);
    },
    setTarget,
    /** The active target without its credentials: {kind, url}, or null. */
    target: () => (active ? { kind: active.kind, url: active.url } : null),
    /** What the last forwarded request got: {at, path, status, error}, or null. */
    lastForward: () => lastForward,
    /** Whether the active target answers, cached for RELAY_PROBE_CACHE_MS: {ok, version, error, at}, or null with no target. */
    async probeTarget() {
      const t = active;
      if (!t) return null;
      if (clock.now() - probe.at < RELAY_PROBE_CACHE_MS) return probe.value;
      let value;
      try {
        value = await probeNow(t);
      } catch (e) {
        value = { ok: false, version: null, error: e?.params?.detail ?? e?.cause?.code ?? e?.message ?? String(e) };
      }
      // A switch during the probe must not leave the old target's answer cached.
      if (active === t) probe = { at: clock.now(), value: { ...value, at: new Date(clock.now()).toISOString() } };
      return { ...value, at: new Date(clock.now()).toISOString() };
    },
  };
}
