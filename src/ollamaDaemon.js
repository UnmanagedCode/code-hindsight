// A read-only client for the Ollama daemon (it runs in cc's container): its version, and the
// models it lists. Everything else the plugin sends it goes through ollamaProxy.
import { AppError } from './errors.js';

export const OLLAMA_PROBE_TIMEOUT_MS = 3_000;

/**
 * @param {{url: string, fetchImpl?: typeof fetch}} o
 */
export function createOllamaDaemon({ url, fetchImpl = fetch }) {
  async function getJson(p) {
    let res;
    try {
      res = await fetchImpl(new URL(p, url), { signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS) });
    } catch (e) {
      throw new AppError('OLLAMA_UNREACHABLE', { url, detail: e?.cause?.code ?? e?.message ?? String(e) });
    }
    if (!res.ok) throw new AppError('OLLAMA_UNREACHABLE', { url, detail: `HTTP ${res.status} from ${p}` });
    try {
      return await res.json();
    } catch {
      throw new AppError('OLLAMA_UNREACHABLE', { url, detail: `${p} did not answer JSON` });
    }
  }
  return {
    url,
    async version() {
      const v = (await getJson('/api/version'))?.version;
      return typeof v === 'string' ? v : null;
    },
    /** The daemon's models; `cloud` is true for one served from ollama.com (`remote_host` set). */
    async tags() {
      const list = (await getJson('/api/tags'))?.models;
      return (Array.isArray(list) ? list : [])
        .map((m) => ({ model: m?.model ?? m?.name, cloud: !!m?.remote_host }))
        .filter((m) => typeof m.model === 'string');
    },
  };
}
