// Hindsight's HTTP API as this plugin uses it: recall from a bank, retain into one, and (for the
// backfill importer) read and delete a document, read an operation's status and retry a failed one. Talks to
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
  const deadline = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(RETAIN_TIMEOUT_MS)]) : AbortSignal.timeout(RETAIN_TIMEOUT_MS));

  /**
   * A request the backfill importer makes; 404 is answered as null. Every other failure is
   * RETAIN_FAILED carrying `status` when Hindsight answered (so a caller can tell a refusal of
   * this one item from Hindsight being unavailable).
   */
  async function call(bank, suffix, { method = 'GET', body, signal, what }) {
    const c = conn();
    let res;
    try {
      res = await fetchImpl(bankUrl(c, bank, suffix), { method, headers: headers(c), body, signal: deadline(signal) });
    } catch (e) {
      throw new AppError('RETAIN_FAILED', { bank, origin: 'backfill', detail: `${what}: ${e?.name === 'TimeoutError' ? `no answer within ${RETAIN_TIMEOUT_MS} ms` : (e?.message ?? String(e))}` }, { cause: e });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError('RETAIN_FAILED', { bank, origin: 'backfill', status: res.status, detail: `${what}: Hindsight answered HTTP ${res.status}` });
    return res.json().catch(() => ({}));
  }

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

    /**
     * Retain one item into its document (`async`, so Hindsight acknowledges before extracting); the
     * item's `update_mode` says append or replace. Resolves on 2xx. A refusal carries `status`.
     */
    async retain(bank, item, { operationId, signal, origin }) {
      const c = conn();
      const from = origin ? { origin } : {};
      let res;
      try {
        res = await fetchImpl(bankUrl(c, bank, 'memories'), {
          method: 'POST', headers: headers(c),
          body: JSON.stringify({ items: [item], async: true, operation_id: operationId }),
          signal: deadline(signal),
        });
      } catch (e) {
        throw new AppError('RETAIN_FAILED', { bank, ...from, detail: e?.name === 'TimeoutError' ? `no answer within ${RETAIN_TIMEOUT_MS} ms` : (e?.message ?? String(e)) }, { cause: e });
      }
      if (!res.ok) throw new AppError('RETAIN_FAILED', { bank, ...from, status: res.status, detail: `Hindsight answered HTTP ${res.status}` });
    },

    /** A document's stored text (`{originalText}`, null when Hindsight keeps none), or null when there is no such document. */
    async getDocument(bank, documentId, { signal } = {}) {
      const body = await call(bank, `documents/${encodeURIComponent(documentId)}`, { signal, what: `reading document ${documentId}` });
      if (body === null) return null;
      return { originalText: typeof body.original_text === 'string' ? body.original_text : null };
    },

    /** An operation's status (`pending|processing|completed|failed|cancelled|not_found`); `not_found` on 404. */
    async operationStatus(bank, operationId, { signal } = {}) {
      const body = await call(bank, `operations/${encodeURIComponent(operationId)}`, { signal, what: `reading operation ${operationId}` });
      if (body === null) return 'not_found';
      return typeof body.status === 'string' ? body.status : 'not_found';
    },

    /** Delete a document and the memories extracted from it; false when there was none. */
    async deleteDocument(bank, documentId, { signal } = {}) {
      return (await call(bank, `documents/${encodeURIComponent(documentId)}`, { method: 'DELETE', signal, what: `deleting document ${documentId}` })) !== null;
    },

    /** Ask Hindsight to run a failed or cancelled operation again. */
    async retryOperation(bank, operationId, { signal } = {}) {
      const body = await call(bank, `operations/${encodeURIComponent(operationId)}/retry`, { method: 'POST', body: '{}', signal, what: `retrying operation ${operationId}` });
      if (body === null) throw new AppError('RETAIN_FAILED', { bank, origin: 'backfill', status: 404, detail: `retrying operation ${operationId}: Hindsight has no such operation` });
    },
  };
}
