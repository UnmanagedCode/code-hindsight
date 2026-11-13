// Per-session retain progress (`memory/cursors.json`, 0600), keyed by the public cc session id so
// it survives /clear, renew and prune (a new transcript, the same id): which turn was retained
// last; the batch currently being sent (kept verbatim so a retry resends the same batch under the
// same operation id); and `pending`, the stretches of turns recorded since, each tagged with the bank
// its own stage chose (or none). Plus the pure placement of those stretches in a transcript tail.
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';
import { isBankId } from './scopes.js';

export const CURSOR_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function createRetainCursors(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'memory', 'cursors.json');
  let data = null;
  // No prototype, own-keys only: a session id such as `__proto__` or `constructor` is just a key.
  const load = () => {
    if (!data) {
      const raw = readJsonFile(file, {});
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('memory/cursors.json is not an object');
      data = Object.assign(Object.create(null), raw);
    }
    return data;
  };
  return {
    get: (sessionId) => (Object.hasOwn(load(), sessionId) ? load()[sessionId] : undefined),
    /** Forget a session's entry (a corrupt one is reset; the next retain starts from the last exchange). */
    drop(sessionId) {
      const all = load();
      delete all[sessionId];
      writePrivateFileAtomic(file, JSON.stringify(all));
    },
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
 * (the id is gone after a rotation or trim) by timestamp: after `from`'s time, up to `to`'s time.
 *
 * `null` means the window cannot be placed in the tail: nothing of it is there, or a boundary id is
 * missing and its time cannot place it. A recorded window always holds at least one turn, so an
 * empty result is a loss, and the caller must report it, never skip it as "no turns".
 *
 * Timestamp fallback treats a turn stamped at exactly `from`'s millisecond as the boundary turn
 * itself (already retained), so it is excluded; siblings of one transcript line share a timestamp,
 * and re-sending the boundary turn after every rotation would be the worse error.
 */
export function windowTurns(tail, from, to) {
  const ids = tail.map((t) => t.id);
  const stamps = tail.map((t) => ts(t.timestamp));
  let start = 0;
  if (from.lastId != null) {
    const i = ids.lastIndexOf(from.lastId);
    if (i >= 0) start = i + 1;
    else {
      const f = ts(from.lastTs);
      if (Number.isNaN(f)) return null;
      start = stamps.findIndex((s) => s > f);
      if (start < 0) return null;
    }
  }
  const j = ids.lastIndexOf(to.lastId);
  let end;
  if (j >= 0) end = j + 1;
  else {
    const e = ts(to.lastTs);
    if (Number.isNaN(e)) return null;
    end = start;
    for (let k = start; k < tail.length; k++) if (stamps[k] <= e) end = k + 1;
  }
  return end > start ? tail.slice(start, end) : null;
}

/**
 * Whether a tail's end is strictly after `prev` (`{lastId, lastTs}`: the newest recorded end). A
 * Stop hook is a separate process, so an older Stop can arrive after a newer one; its tail is stale
 * and must not move the persisted state backwards. If `prev` is in the tail it must not be the last
 * turn; otherwise (a rotation) the tail's newest timestamp must be later, when both parse.
 */
export function endsAfter(turns, prev) {
  if (!turns.length) return false;
  const i = prev.lastId == null ? -1 : turns.map((t) => t.id).lastIndexOf(prev.lastId);
  if (i >= 0) return i < turns.length - 1;
  const a = ts([...turns].reverse().find((t) => t.timestamp)?.timestamp);
  const b = ts(prev.lastTs);
  return Number.isNaN(a) || Number.isNaN(b) ? true : a > b;
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrOrNull = (v) => v === null || typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validSession = (s) => isObj(s) && ['project', 'worktree', 'kind'].every((k) => isStr(s[k])) && (s.stage === null || s.stage === undefined || typeof s.stage === 'string');
const validWindow = (w) => isObj(w) && (w.bank === null || isBankId(w.bank)) && validSession(w.session) && isStr(w.lastId) && isStrOrNull(w.lastTs);
const validInflight = (f) => isObj(f) && isBankId(f.bank) && isStr(f.operationId) && isObj(f.item) && isStr(f.item.content)
  && isStr(f.lastId) && isStrOrNull(f.lastTs) && Number.isInteger(f.count) && validSession(f.session);

/** Whether a stored cursor entry has the shape this module writes. A violation is corruption: never act on it. */
export function isValidCursor(c) {
  return isObj(c) && isStrOrNull(c.lastId) && isStrOrNull(c.lastTs)
    && Array.isArray(c.pending) && c.pending.every(validWindow)
    && (c.inflight === undefined || validInflight(c.inflight));
}

/** A v4-shaped UUID derived from the batch, so resending a batch repeats its operation id. */
export function operationIdFor(bank, documentId, firstId, lastId) {
  const h = crypto.createHash('sha256').update(`${bank}\n${documentId}\n${firstId}\n${lastId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
