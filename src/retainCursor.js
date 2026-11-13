// Per-session retain progress (`memory/cursors.json`, 0600), keyed by the public cc session id so
// it survives /clear, renew and prune (a new transcript, the same id): which turn was retained
// last, and the batch currently being sent (kept verbatim so a retry resends the same batch under
// the same operation id). Plus the pure choice of which turns are new.
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const CURSOR_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function createRetainCursors(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'memory', 'cursors.json');
  let data = null;
  const load = () => (data ??= readJsonFile(file, {}));
  return {
    get: (sessionId) => load()[sessionId],
    set(sessionId, entry) {
      const all = load();
      all[sessionId] = { ...entry, at: now() };
      for (const [k, v] of Object.entries(all)) if (now() - (v.at ?? 0) > CURSOR_MAX_AGE_MS) delete all[k];
      writePrivateFileAtomic(file, JSON.stringify(all));
    },
  };
}

const ts = (t) => (t ? Date.parse(t) : NaN);

/** The end of a tail: its last turn's id and the newest timestamp seen (else the cursor's). */
export function tailEnd(turns, cursor) {
  const stamped = [...turns].reverse().find((t) => t.timestamp);
  return { lastId: turns[turns.length - 1].id, lastTs: stamped?.timestamp ?? cursor?.lastTs ?? null };
}

/**
 * The turns of `turns` (a transcript's tail) not yet retained.
 * - no cursor: the last exchange only (from the last user turn on) — earlier history is never backfilled;
 * - cursor id found: what follows it;
 * - cursor id not found (rotation, or a tail cut past it): turns stamped after the cursor's time.
 */
export function newTurns(turns, cursor) {
  if (!cursor) {
    const i = turns.map((t) => t.role).lastIndexOf('user');
    return i < 0 ? [] : turns.slice(i);
  }
  const i = turns.map((t) => t.id).lastIndexOf(cursor.lastId);
  if (i >= 0) return turns.slice(i + 1);
  const from = ts(cursor.lastTs);
  return Number.isNaN(from) ? [] : turns.filter((t) => ts(t.timestamp) > from);
}

/** A v4-shaped UUID derived from the batch, so resending a batch repeats its operation id. */
export function operationIdFor(bank, documentId, firstId, lastId) {
  const h = crypto.createHash('sha256').update(`${bank}\n${documentId}\n${firstId}\n${lastId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
