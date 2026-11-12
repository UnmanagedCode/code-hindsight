// The API container's LLM environment. Three modes: none (Hindsight's chunks-only mode), manual
// (provider, model, URL and key from Settings), and cc-backend: a live link to one of cc's
// Anthropic-compatible backend rows, read from cc at each container (re)create. A linked
// token goes straight into the container env; it is never stored, logged or returned.
import { AppError } from './errors.js';

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

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0';
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

/** How one cc backend maps to Hindsight's anthropic provider, or the refusal code. */
function linkOf(row) {
  const env = envOf(row);
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  if (!baseUrl || !token) return { refusal: 'CC_BACKEND_UNSUPPORTED' };
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return { refusal: 'CC_BACKEND_UNSUPPORTED' }; }
  if (isLoopbackHost(host)) return { refusal: 'CC_BACKEND_LOOPBACK', host };
  return { baseUrl, token, host };
}

/** The picker's view of cc's backends: ids, labels, host and model names, never a token. */
export function summarizeCcBackends(data) {
  const models = data?.backendModels && typeof data.backendModels === 'object' ? data.backendModels : {};
  return backendRows(data).map((row) => {
    const link = linkOf(row);
    let host = link.host ?? null;
    if (!host) { try { host = new URL(envOf(row).ANTHROPIC_BASE_URL).hostname; } catch { host = null; } }
    return {
      id: row.id,
      label: typeof row.label === 'string' ? row.label : row.id,
      host,
      usable: !link.refusal,
      refusal: link.refusal ?? null,
      models: (Array.isArray(models[row.id]) ? models[row.id] : []).filter((m) => m && typeof m.model === 'string').map((m) => ({ model: m.model, label: typeof m.label === 'string' ? m.label : m.model })),
    };
  });
}

/**
 * @param {object} settings validated settings
 * @param {{llmApiKey?: string}} secrets
 * @param {{fetchCcModels: () => Promise<unknown>}} deps
 * @returns {Promise<Record<string, string>>}
 */
export async function composeLlmEnv(settings, secrets, { fetchCcModels: fetchModels }) {
  const l = settings.llm;
  if (l.mode === 'none') return { HINDSIGHT_API_LLM_PROVIDER: 'none' };
  if (l.mode === 'manual') {
    const env = { HINDSIGHT_API_LLM_PROVIDER: l.provider, HINDSIGHT_API_LLM_MODEL: l.model };
    if (l.baseUrl) env.HINDSIGHT_API_LLM_BASE_URL = l.baseUrl;
    if (secrets.llmApiKey) env.HINDSIGHT_API_LLM_API_KEY = secrets.llmApiKey;
    return env;
  }
  // cc-backend
  const row = backendRows(await fetchModels()).find((b) => b.id === l.backendId);
  if (!row) throw new AppError('CC_BACKEND_MISSING', { backendId: l.backendId });
  const link = linkOf(row);
  if (link.refusal) throw new AppError(link.refusal, { backendId: l.backendId, host: link.host });
  return {
    HINDSIGHT_API_LLM_PROVIDER: 'anthropic',
    HINDSIGHT_API_LLM_MODEL: l.model,
    HINDSIGHT_API_LLM_BASE_URL: link.baseUrl,
    HINDSIGHT_API_LLM_API_KEY: link.token,
  };
}
