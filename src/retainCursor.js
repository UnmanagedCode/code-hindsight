// Per-session retain progress (`memory/cursors.json`, 0600), keyed by the public cc session id so
// it survives /clear, renew and prune (a new transcript, the same id): which turn was retained
// last; the batch currently being sent (kept verbatim so a retry resends the same batch under the
// same operation id); and `pending`, the stretches of turns recorded since, each tagged with the bank
// its own stage chose (or none). Plus the pure placement of those stretches in a transcript tail.
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const CURSOR_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function createRetainCursors(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'memory', 'cursors.json');
  let data = null;
  // No prototype, own-keys only: a session id such as `__proto__` or `constructor` is just a key.
  const load = () => (data ??= Object.assign(Object.create(null), readJsonFile(file, {})));
  return {
    get: (sessionId) => (Object.hasOwn(load(), sessionId) ? load()[sessionId] : undefined),
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
 * Where the first window of a session with no cursor starts: just before the last user turn, so
 * only the last exchange is retained and earlier history is never backfilled. `{lastId: null,
 * lastTs: null}` means the start of the tail; undefined when the tail has no user turn.
 */
export function lastExchangeBoundary(turns) {
  const i = turns.map((t) => t.role).lastIndexOf('user');
  if (i < 0) return undefined;
  const before = turns[i - 1];
  return { lastId: before?.id ?? null, lastTs: before?.timestamp ?? null };
}

/**
 * The turns of a tail strictly after `from` up to and including `to` (each `{lastId, lastTs}`): a
 * window of the transcript that belongs to one retain target. A boundary is found by turn id, else
 * by timestamp (the id is gone after a rotation). `null` when a boundary cannot be placed in the
 * tail at all (its turns left the tail): the caller must treat that as a loss, not as "no turns".
 */
export function windowTurns(tail, from, to) {
  const lastIdx = (id) => (id == null ? -1 : tail.map((t) => t.id).lastIndexOf(id));
  let start = 0;
  if (from.lastId != null) {
    const i = lastIdx(from.lastId);
    if (i >= 0) start = i + 1;
    else {
      const f = ts(from.lastTs);
      if (Number.isNaN(f)) return null;
      start = tail.findIndex((t) => ts(t.timestamp) > f);
      if (start < 0) return [];
    }
  }
  const j = lastIdx(to.lastId);
  let end;
  if (j >= 0) end = j + 1;
  else {
    const e = ts(to.lastTs);
    if (Number.isNaN(e)) return null;
    end = start;
    while (end < tail.length && ts(tail[end].timestamp) <= e) end++;
  }
  return end > start ? tail.slice(start, end) : [];
}

/** A v4-shaped UUID derived from the batch, so resending a batch repeats its operation id. */
export function operationIdFor(bank, documentId, firstId, lastId) {
  const h = crypto.createHash('sha256').update(`${bank}\n${documentId}\n${firstId}\n${lastId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
