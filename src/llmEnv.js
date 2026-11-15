// The API container's LLM environment. Three modes: none (Hindsight's chunks-only mode), manual
// (provider, model, URL and key from Settings), and cc-backend: a live link to one of cc's
// backend rows, read from cc at each start. An Anthropic-compatible row on a public address
// goes straight into the container env; a loopback one (and Ollama) is reached through the
// relay, and its token stays in the plugin. A token is never stored, logged or returned.
import net from 'node:net';
import { AppError } from './errors.js';
import { RELAY_TARGETS } from './pins.js';

const FETCH_TIMEOUT_MS = 10_000;

/** GET $CONDUCTOR_URL/api/settings/models (cc's backend registry). */
export async function fetchCcModels(conductorUrl, { fetchImpl = fetch } = {}) {
  if (!conductorUrl) throw new AppError('CC_UNREACHABLE', { detail: 'CONDUCTOR_URL is not set (not running under cc)' });
  let res;
  try {
    res = await fetchImpl(new URL('/api/settings/models', conductorUrl), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new AppError('CC_UNREACHABLE', { detail: e?.message ?? String(e) });
  }
  if (!res.ok) throw new AppError('CC_UNREACHABLE', { detail: `HTTP ${res.status}` });
  try {
    return await res.json();
  } catch {
    throw new AppError('CC_ROUTE_CHANGED', { detail: 'not JSON' });
  }
}

/** IPv6 text → its eight 16-bit words (an embedded dotted IPv4 tail included), or null. */
function ipv6Words(h) {
  let text = h;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    text = `${text.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const a = head ? head.split(':') : [];
  const b = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - a.length - b.length;
  const words = [...a, ...Array(fill).fill('0'), ...b].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff) ? words : null;
}

/**
 * Whether a URL hostname names this machine's loopback (or the unspecified address).
 * Best-effort over literal addresses and `localhost`: pass a WHATWG `URL().hostname`, which
 * already normalizes IPv4 shorthand (`127.1`, `2130706433`, `0x7f000001`) and IPv6 forms.
 * Names are not resolved through DNS.
 */
export function isLoopbackHost(hostname) {
  let h = String(hostname).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const kind = net.isIP(h);
  if (kind === 4) return h.startsWith('127.') || h === '0.0.0.0';
  if (kind !== 6) return false;
  const w = ipv6Words(h);
  if (!w) return false;
  if (w.slice(0, 7).every((x) => x === 0) && (w[7] === 1 || w[7] === 0)) return true; // ::1, ::
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 address.
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) {
    const v4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
    return v4.startsWith('127.') || v4 === '0.0.0.0';
  }
  return false;
}

/** cc's registry rows, checked for the shape this module reads. */
function backendRows(data) {
  if (!data || !Array.isArray(data.backends)) throw new AppError('CC_ROUTE_CHANGED', { detail: 'no backends list' });
  for (const b of data.backends) {
    if (!b || typeof b.id !== 'string' || !Array.isArray(b.env ?? [])) throw new AppError('CC_ROUTE_CHANGED', { detail: 'a backend row has no id or env list' });
  }
  return data.backends;
}

const envOf = (row) => Object.fromEntries((row.env ?? []).filter((e) => e && typeof e.key === 'string').map((e) => [e.key, String(e.value ?? '')]));

/** Whether a cc backend row launches the `ollama` CLI (by its template, not its id). */
export const isOllamaRow = (row) => typeof row.template === 'string' && /^\s*ollama(\s|$)/.test(row.template);

/**
 * How one cc backend maps to a Hindsight provider: `{kind: 'anthropic', baseUrl, token, host}`,
 * `{kind: 'anthropic', loopback: true, baseUrl, auth, host}` (a plain-HTTP loopback endpoint,
 * reached through the relay; `auth` is the header the plugin injects), `{kind: 'ollama'}`
 * (also through the relay), or `{refusal}`.
 */
function linkOf(row) {
  const env = envOf(row);
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  if (baseUrl && token) {
    let url;
    try { url = new URL(baseUrl); } catch { return { refusal: 'CC_BACKEND_UNSUPPORTED' }; }
    const host = url.hostname;
    if (!isLoopbackHost(host)) return { kind: 'anthropic', baseUrl, token, host };
    if (url.protocol !== 'http:') return { kind: 'anthropic', loopback: true, refusal: 'CC_BACKEND_LOOPBACK', host };
    // The row's own credential form: a bearer token (how Claude Code sends it) or an x-api-key.
    const auth = env.ANTHROPIC_AUTH_TOKEN ? { header: 'authorization', value: `Bearer ${token}` } : { header: 'x-api-key', value: token };
    return { kind: 'anthropic', loopback: true, baseUrl, auth, host };
  }
  if (isOllamaRow(row)) return { kind: 'ollama' };
  return { refusal: 'CC_BACKEND_UNSUPPORTED' };
}

/** Claude Code's launch tag on a model id (`gpt-5.6-luna[1m]`): not part of the id a provider knows. */
const LAUNCH_TAG = /\[[^\]]*\]$/;
const MODEL_ENV_KEYS = ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];

/**
 * The models of an Anthropic-compatible row: cc's list with launch tags stripped, then the
 * concrete model ids in the row's env (a `{model}` placeholder is not one). `freeModel`: the row
 * names no concrete model, so any id may be typed.
 */
function anthropicModels(row, configured) {
  const seen = new Map();
  for (const m of configured) {
    const id = m.model.replace(LAUNCH_TAG, '');
    if (id && !seen.has(id)) seen.set(id, typeof m.label === 'string' ? m.label : id);
  }
  const env = envOf(row);
  const concrete = MODEL_ENV_KEYS.map((k) => env[k]).filter((v) => v && !v.includes('{'));
  for (const id of concrete) if (!seen.has(id)) seen.set(id, id);
  return { models: [...seen].map(([model, label]) => ({ model, label })), freeModel: concrete.length === 0 };
}

/**
 * The picker's view of cc's backends: ids, labels, host and model names, never a token.
 * An Ollama row also carries the daemon's state, and its models are cc's configured ones
 * followed by the daemon's own. A model is `cloud: false` only when the daemon lists it
 * without `remote_host`; anything else (cc's unpulled cloud models, an unreachable daemon)
 * counts as cloud.
 * @param {unknown} data cc's /api/settings/models
 * @param {{reachable: boolean, version: string|null, error: string|null, tags: {model: string, cloud: boolean}[]}|null} [daemon]
 */
export function summarizeCcBackends(data, daemon = null) {
  const models = data?.backendModels && typeof data.backendModels === 'object' ? data.backendModels : {};
  return backendRows(data).map((row) => {
    const link = linkOf(row);
    let host = link.host ?? null;
    if (!host) { try { host = new URL(envOf(row).ANTHROPIC_BASE_URL).hostname; } catch { host = null; } }
    const configured = (Array.isArray(models[row.id]) ? models[row.id] : []).filter((m) => m && typeof m.model === 'string');
    const out = {
      id: row.id,
      label: typeof row.label === 'string' ? row.label : row.id,
      kind: link.kind ?? null,
      host,
      loopback: link.loopback === true,
      usable: !link.refusal,
      refusal: link.refusal ?? null,
      models: configured.map((m) => ({ model: m.model, label: typeof m.label === 'string' ? m.label : m.model })),
    };
    if (link.kind === 'anthropic') return { ...out, ...anthropicModels(row, configured) };
    if (link.kind !== 'ollama') return out;
    const tags = new Map((daemon?.tags ?? []).map((t) => [t.model, t.cloud]));
    const known = new Set(configured.map((m) => m.model));
    out.host = null;
    out.daemon = { reachable: !!daemon?.reachable, version: daemon?.version ?? null, error: daemon?.error ?? null };
    out.models = [
      ...out.models.map((m) => ({ ...m, cloud: tags.get(m.model) !== false, source: 'cc' })),
      ...[...tags].filter(([model]) => !known.has(model)).map(([model, cloud]) => ({ model, label: model, cloud, source: 'daemon' })),
    ];
    return out;
  });
}

/** `HINDSIGHT_API_LLM_MAX_CONCURRENT` when the setting is set. */
const concurrencyEnv = (l) => (l.maxConcurrent === null ? {} : { HINDSIGHT_API_LLM_MAX_CONCURRENT: String(l.maxConcurrent) });

/**
 * @param {object} settings validated settings
 * @param {{llmApiKey?: string, relayKey?: string}} secrets
 * @param {{fetchCcModels: () => Promise<unknown>}} deps
 * @returns {Promise<{env: Record<string, string>, relay: null | {kind: 'ollama'} | {kind: 'anthropic-loopback', url: string, auth: {header: string, value: string}}}>}
 *   `relay`: what the env's relay alias must reach, or null when the API's LLM needs no relay
 */
export async function composeLlmEnv(settings, secrets, { fetchCcModels: fetchModels }) {
  const l = settings.llm;
  if (l.mode === 'none') return { env: { HINDSIGHT_API_LLM_PROVIDER: 'none' }, relay: null };
  if (l.mode === 'manual') {
    const env = { HINDSIGHT_API_LLM_PROVIDER: l.provider, HINDSIGHT_API_LLM_MODEL: l.model, ...concurrencyEnv(l) };
    if (l.baseUrl) env.HINDSIGHT_API_LLM_BASE_URL = l.baseUrl;
    if (secrets.llmApiKey) env.HINDSIGHT_API_LLM_API_KEY = secrets.llmApiKey;
    return { env, relay: null };
  }
  // cc-backend
  const row = backendRows(await fetchModels()).find((b) => b.id === l.backendId);
  if (!row) throw new AppError('CC_BACKEND_MISSING', { backendId: l.backendId });
  const link = linkOf(row);
  if (link.refusal) throw new AppError(link.refusal, { backendId: l.backendId, host: link.host });
  if (link.kind === 'ollama') {
    const t = RELAY_TARGETS.ollama;
    // Hindsight sends the key as a Bearer token on both Ollama paths; the plugin checks it.
    return {
      env: {
        HINDSIGHT_API_LLM_PROVIDER: 'ollama',
        HINDSIGHT_API_LLM_MODEL: l.model,
        HINDSIGHT_API_LLM_BASE_URL: `http://${t.alias}:${t.apiPort}/v1`,
        HINDSIGHT_API_LLM_API_KEY: secrets.relayKey,
        ...concurrencyEnv(l),
      },
      relay: { kind: 'ollama' },
    };
  }
  if (link.loopback) {
    const t = RELAY_TARGETS['anthropic-loopback'];
    // The Anthropic SDK sends the key as x-api-key; the plugin checks it and injects the row's token.
    return {
      env: {
        HINDSIGHT_API_LLM_PROVIDER: 'anthropic',
        HINDSIGHT_API_LLM_MODEL: l.model,
        HINDSIGHT_API_LLM_BASE_URL: `http://${t.alias}:${t.apiPort}`,
        HINDSIGHT_API_LLM_API_KEY: secrets.relayKey,
        ...concurrencyEnv(l),
      },
      relay: { kind: 'anthropic-loopback', url: link.baseUrl, auth: link.auth },
    };
  }
  return {
    env: {
      HINDSIGHT_API_LLM_PROVIDER: 'anthropic',
      HINDSIGHT_API_LLM_MODEL: l.model,
      HINDSIGHT_API_LLM_BASE_URL: link.baseUrl,
      HINDSIGHT_API_LLM_API_KEY: link.token,
      ...concurrencyEnv(l),
    },
    relay: null,
  };
}
