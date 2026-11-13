// Hindsight's HTTP API as this plugin uses it: recall from a bank and retain into one. Talks to
// the supervisor's current connection (URL and Bearer key); never to a bank the caller names
// beyond the id it is given.
import { AppError } from './errors.js';

export const RECALL_BUDGET = 'mid';
export const RECALL_MAX_TOKENS = 1500;
export const RETAIN_TIMEOUT_MS = 10_000;

/** @param {{connection: () => ({apiUrl: string, apiKey: string}|null), fetchImpl?: typeof fetch}} o */
export function createHindsightClient({ connection, fetchImpl = fetch }) {
  function conn() {
    const c = connection();
    if (!c) throw new AppError('HINDSIGHT_NOT_READY');
    return c;
  }
  const bankUrl = (c, bank, suffix) => `${c.apiUrl}/v1/default/banks/${encodeURIComponent(bank)}/${suffix}`;
  const headers = (c) => ({ authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' });

  return {
    isReady: () => connection() !== null,

    /**
     * Recall results (`[{id, text, type, …}]`). A bank that was never created answers 404, which is
     * an empty result, not an error. No `types` filter: with LLM none Hindsight stores raw chunks as
     * `world` facts, and filtering would hide them.
     */
    async recall(bank, query, { timeoutMs }) {
      const c = conn();
      let res;
      try {
        res = await fetchImpl(bankUrl(c, bank, 'memories/recall'), {
          method: 'POST', headers: headers(c),
          body: JSON.stringify({ query, budget: RECALL_BUDGET, max_tokens: RECALL_MAX_TOKENS }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new AppError('RECALL_FAILED', { bank, detail: e?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : (e?.message ?? String(e)) }, { cause: e });
      }
      if (res.status === 404) return [];
      if (!res.ok) throw new AppError('RECALL_FAILED', { bank, detail: `Hindsight answered HTTP ${res.status}` });
      const body = await res.json().catch(() => null);
      return Array.isArray(body?.results) ? body.results.filter((r) => r && typeof r.text === 'string') : [];
    },

    /** Append one item to its document (`async`, so Hindsight acknowledges before extracting). Resolves on 2xx. */
    async retain(bank, item, { operationId }) {
      const c = conn();
      let res;
      try {
        res = await fetchImpl(bankUrl(c, bank, 'memories'), {
          method: 'POST', headers: headers(c),
          body: JSON.stringify({ items: [item], async: true, operation_id: operationId }),
          signal: AbortSignal.timeout(RETAIN_TIMEOUT_MS),
        });
      } catch (e) {
        throw new AppError('RETAIN_FAILED', { bank, detail: e?.name === 'TimeoutError' ? `no answer within ${RETAIN_TIMEOUT_MS} ms` : (e?.message ?? String(e)) }, { cause: e });
      }
      if (!res.ok) throw new AppError('RETAIN_FAILED', { bank, detail: `Hindsight answered HTTP ${res.status}` });
    },
  };
}
