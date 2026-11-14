// The backfill importer: on request, retain past cc sessions' saved Claude Code transcripts into
// the banks their scopes choose. Two job kinds over the shared job runner:
// - `backfill-scan` (a dry run): find transcript files, place each through cc's record (cached in
//   backfillPlacements.js), match scopes, check live memory's overlap and what Hindsight already
//   holds, and estimate the LLM tokens. It retains nothing, and reads each file at most once.
// - `backfill-import` (after an explicit confirm): send the chosen sessions, one request at a time.
// Transcripts are streamed and summarised (part sizes and content hashes), never held whole.
// It never touches the live `cc-session:<id>` documents or `memory/cursors.json` (a read-only peeker).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { matchScopes, renderBank, withWorkspace } from './scopes.js';
import { buildRetainItem, renderTurn } from './retainItem.js';
import { operationIdFor } from './retainCursor.js';
import { isSessionId } from './ccSession.js';
import { transcriptTurns } from '../claude/hooks/transcript.mjs';

const MiB = 1024 * 1024;
export const BACKFILL_LIMITS = Object.freeze({
  /** A larger transcript file is skipped without being read. */
  fileMaxBytes: 512 * MiB,
  /** A longer transcript line is dropped while it streams (counted `oversized`). */
  lineMaxBytes: 32 * MiB,
  /** Largest rendered content of one retained document; a session is split into parts at turn boundaries. A longer single turn skips the session. */
  documentMaxChars: 1_000_000,
  /** A transcript whose turns render to more characters than this is skipped. */
  sessionMaxChars: 20_000_000,
  /** Deadline of each describe_session call while scanning. */
  describeTimeoutMs: 15_000,
  /** This many consecutive cc failures abort a scan. */
  ccFailuresMax: 5,
  /** The scan's orphan probe stops after this many consecutive missing part numbers (it tolerates gaps). */
  orphanProbeMisses: 3,
  /** Body limit of an import request (it names every chosen session). */
  selectionMaxBytes: 4 * MiB,
});

/**
 * The dry run's token heuristic. `chunkChars` is Hindsight's `DEFAULT_RETAIN_CHUNK_SIZE`
 * (`hindsight_api/config.py` at `UPSTREAM_REVISION`; the plugin sets no bank config).
 * `promptTokensPerChunk` covers the extraction prompt sent with every chunk
 * (`_BASE_FACT_EXTRACTION_PROMPT` plus its schema and context); `outputTokensPerChunk` the
 * extracted facts. Rough by design: the server's chunking decides the real use.
 */
export const BACKFILL_ESTIMATE = Object.freeze({ chunkChars: 3000, charsPerToken: 4, promptTokensPerChunk: 1000, outputTokensPerChunk: 500 });

const CONTEXT_SUFFIX = "Imported from the session's saved transcript after it ended.";
const LIVE_DOC = (handle) => `cc-session:${handle}`;

/** The document id of part `n` (from 1) of one transcript segment; never `cc-session:`. */
export const backfillDocumentId = (handle, backingId, n) => `cc-backfill:${handle}:${backingId}:p${n}`;

/** SHA-256 (hex) of a document's content, as the importer compares stored and planned parts. */
export const contentHash = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The token estimate of one document of `chars` characters. LLM mode `none` makes no LLM calls. */
export function estimateDocument(chars, llmMode, basis = BACKFILL_ESTIMATE) {
  const chunks = Math.ceil(chars / basis.chunkChars);
  if (llmMode === 'none') return { chunks, inputTokens: 0, outputTokens: 0 };
  return {
    chunks,
    inputTokens: Math.ceil(chars / basis.charsPerToken) + chunks * basis.promptTokensPerChunk,
    outputTokens: chunks * basis.outputTokensPerChunk,
  };
}

const sumEstimates = (list) => list.reduce((a, e) => ({ chunks: a.chunks + e.chunks, inputTokens: a.inputTokens + e.inputTokens, outputTokens: a.outputTokens + e.outputTokens }), { chunks: 0, inputTokens: 0, outputTokens: 0 });

/**
 * Splits a stream of turns into parts at turn boundaries, each part's rendered content (the
 * retain item's `content`: lines joined by newlines) at most `maxChars`. A part is
 * `{n, chars, hash, firstId, lastId, turns}`; `turns` is kept only when `keep(n)`.
 */
function createSplitter(maxChars, keep) {
  let n = 0;
  let cur = null;
  const close = () => {
    const done = { n: cur.n, chars: cur.chars, hash: cur.hash.digest('hex'), firstId: cur.firstId, lastId: cur.lastId, turns: cur.turns };
    cur = null;
    return done;
  };
  return {
    /** Add a turn (`line` its rendering); returns the part this closed, or null. */
    add(t, line) {
      const closed = cur && cur.chars + 1 + line.length > maxChars ? close() : null;
      if (!cur) {
        n++;
        cur = { n, chars: line.length, hash: crypto.createHash('sha256').update(line), firstId: t.id, lastId: t.id, turns: keep(n) ? [t] : null };
      } else {
        cur.chars += 1 + line.length;
        cur.hash.update('\n').update(line);
        cur.lastId = t.id;
        cur.turns?.push(t);
      }
      return closed;
    },
    /** The last part, or null. */
    end: () => (cur ? close() : null),
  };
}

const parses = (ts) => typeof ts === 'string' && !Number.isNaN(Date.parse(ts));
/** Whether a turn is imported under `cutoffMs` (null: every turn; else only timestamped turns strictly before it). */
const beforeCutoff = (t, cutoffMs) => cutoffMs === null || (parses(t.timestamp) && Date.parse(t.timestamp) < cutoffMs);

/** The earliest turn timestamp in a live document's stored JSONL, or null. */
function earliestLineTime(text) {
  let min = null;
  for (const raw of text.split('\n')) {
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    const ts = line && typeof line === 'object' ? line.timestamp : undefined;
    if (parses(ts) && (min === null || Date.parse(ts) < min)) min = Date.parse(ts);
  }
  return min;
}

/** A skip: carried as a value inside this module, never thrown out of it. */
class Skip {
  constructor(code, params = {}) { this.code = code; this.params = params; }
}

const throwIfAborted = (signal) => { if (signal?.aborted) throw signal.reason ?? new Error('aborted'); };

/** Whether a Hindsight failure concerns this one session's item only (a 4xx other than an auth refusal). */
const refusedItem = (e) => e?.code === 'RETAIN_FAILED' && e.params?.status >= 400 && e.params.status < 500 && e.params.status !== 401 && e.params.status !== 403;

/**
 * @param {object} o
 * @param {{get: () => object[]}} o.scopes
 * @param {ReturnType<import('./ccSession.js').createCcClient>} o.cc
 * @param {ReturnType<import('./hindsightClient.js').createHindsightClient>} o.hindsight
 * @param {{peeker(): (sessionId: string) => object|undefined}} o.cursors
 * @param {ReturnType<import('./activity.js').createActivityLog>} o.activity
 * @param {{get: () => {llm: {mode: string, model: string|null}}}} o.settings
 * @param {ReturnType<import('./backfillPlacements.js').createPlacementCache>} o.placements
 * @param {string} o.transcriptsRoot Claude Code's `projects` dir
 */
export function createBackfill({ scopes, cc, hindsight, cursors, activity, settings, placements, transcriptsRoot, limits = BACKFILL_LIMITS, now = () => Date.now() }) {
  /** The latest scan: its public view and, per ready/imported key, what an import needs. */
  let latest = null;

  function savedScopes() {
    try { return scopes.get(); } catch (e) { throw new AppError('SCOPES_INVALID', { fields: [{ field: 'scopes.json', message: e.message }] }); }
  }
  const hashOf = (list) => crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
  const message = (code, params) => new AppError(code, params).message;

  /** Top-level `<id>.jsonl` regular files in each directory of the transcripts root, by path. */
  function listFiles(line) {
    let dirs;
    try { dirs = fs.readdirSync(transcriptsRoot, { withFileTypes: true }); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      line('no transcripts directory');
      return [];
    }
    const out = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let entries;
      try { entries = fs.readdirSync(path.join(transcriptsRoot, d.name), { withFileTypes: true }); } catch { continue; }
      for (const f of entries) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const backingId = f.name.slice(0, -'.jsonl'.length);
        if (!isSessionId(backingId)) continue;
        out.push({ key: `${d.name}/${f.name}`, backingId, file: path.join(transcriptsRoot, d.name, f.name) });
      }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * One streaming pass over a transcript: what would be imported under `cutoffMs` (null: all),
   * without keeping turn text. `parts` are `{chars, hash, firstId, lastId}`. Stops reading once
   * the whole file renders past `sessionMaxChars` (`sessionTooLarge`).
   */
  async function summarize(file, cutoffMs, signal) {
    const stats = { lines: 0, malformed: 0, oversized: 0 };
    const splitter = createSplitter(limits.documentMaxChars, () => false);
    const s = { totalTurns: 0, totalChars: 0, sessionTooLarge: false, turns: 0, untimed: 0, firstAt: null, lastAt: null, parts: [], turnTooLarge: false };
    const push = (p) => { if (p) s.parts.push({ chars: p.chars, hash: p.hash, firstId: p.firstId, lastId: p.lastId }); };
    for await (const t of transcriptTurns(file, { lineMaxBytes: limits.lineMaxBytes, signal, stats })) {
      const line = renderTurn(t);
      s.totalChars += (s.totalTurns ? 1 : 0) + line.length;
      s.totalTurns++;
      if (s.totalChars > limits.sessionMaxChars) { s.sessionTooLarge = true; break; }
      if (cutoffMs !== null && !parses(t.timestamp)) { s.untimed++; continue; }
      if (!beforeCutoff(t, cutoffMs)) continue;
      s.turns++;
      if (parses(t.timestamp)) { s.firstAt ??= t.timestamp; s.lastAt = t.timestamp; }
      if (line.length > limits.documentMaxChars) s.turnTooLarge = true;
      push(splitter.add(t, line));
    }
    push(splitter.end());
    return { ...s, malformed: stats.malformed, oversized: stats.oversized };
  }

  /** Why a summarised transcript is not imported, or null. */
  function refusal(summary, cutoffMs) {
    if (summary.sessionTooLarge) return new Skip('TRANSCRIPT_SESSION_TOO_LARGE', { max: limits.sessionMaxChars });
    if (!summary.totalTurns) return new Skip('TRANSCRIPT_EMPTY');
    if (!summary.turns) return new Skip(cutoffMs === null ? 'TRANSCRIPT_EMPTY' : 'ALREADY_LIVE');
    if (summary.turnTooLarge) return new Skip('TRANSCRIPT_TURN_TOO_LARGE', { max: limits.documentMaxChars });
    return null;
  }

  /** Whether live retain still holds unsent turns of this session (their start is unknown). */
  function liveRetainPending(peek, handle) {
    const c = peek(handle);
    return !!c && (!!c.inflight || (Array.isArray(c.pending) && c.pending.length > 0));
  }

  /**
   * Where live memory of this session starts: the earliest turn timestamp of its `cc-session:`
   * document across every bank a retain scope renders for it (whether or not that scope matches
   * now: stages may have changed since). null when there is none; a Skip when it cannot be read.
   * Hindsight failures throw.
   */
  async function liveCutoff(list, session, signal) {
    const banks = [...new Set(list.filter((sc) => sc.actions.includes('retain')).map((sc) => renderBank(sc.bank, session).bank).filter(Boolean))];
    let cutoff = null;
    for (const bank of banks) {
      const doc = await hindsight.getDocument(bank, LIVE_DOC(session.sessionId), { signal });
      if (!doc) continue;
      const t = doc.originalText === null ? null : earliestLineTime(doc.originalText);
      if (t === null) return new Skip('LIVE_OVERLAP_UNKNOWN', { bank });
      if (cutoff === null || t < cutoff) cutoff = t;
    }
    return cutoff;
  }

  /** The bank a placed session's scopes retain it into, or a Skip. */
  async function target(list, session) {
    const placed = await withWorkspace(list, session, cc.workspaceOf);
    const m = matchScopes(list, placed);
    if (m.retainUnresolved) {
      const k = m.skipped.find((x) => x.code === 'WORKSPACE_UNRESOLVED');
      return new Skip('WORKSPACE_UNRESOLVED', { scope: k?.scope, detail: k?.detail });
    }
    if (!m.retain) {
      const k = m.skipped.find((x) => x.code === 'BANK_RENDER_FAILED' && list.find((sc) => sc.name === x.scope)?.actions.includes('retain'));
      return k ? new Skip('BANK_RENDER_FAILED', { scope: k.scope, detail: k.detail }) : new Skip('NO_RETAIN_SCOPE');
    }
    return m.retain;
  }

  /**
   * What the bank holds of a session's planned parts: `stored` (same content), `outdated` (the id
   * exists with other content) and `orphanParts`, the part numbers past the plan that exist, probed
   * upwards across gaps until `orphanProbeMisses` consecutive numbers are missing (an interrupted
   * deletion can leave a gap).
   */
  async function storedState(bank, handle, backingId, parts, signal) {
    let stored = 0;
    let outdated = 0;
    for (let n = 1; n <= parts.length; n++) {
      const doc = await hindsight.getDocument(bank, backfillDocumentId(handle, backingId, n), { signal });
      if (!doc) continue;
      if (doc.originalText !== null && contentHash(doc.originalText) === parts[n - 1].hash) stored++; else outdated++;
    }
    const orphanParts = [];
    for (let n = parts.length + 1, misses = 0; misses < limits.orphanProbeMisses; n++) {
      if (await hindsight.getDocument(bank, backfillDocumentId(handle, backingId, n), { signal })) { orphanParts.push(n); misses = 0; } else misses++;
    }
    return { stored, outdated, orphanParts };
  }

  async function scan({ fresh }, { line, progress, signal }) {
    const list = savedScopes();
    const llm = settings.get().llm;
    const llmMode = llm.mode;
    const peek = cursors.peeker();
    const files = listFiles(line);
    progress(0, files.length, 'files');
    if (placements.load({ fresh }).corrupt) line('the placement cache was unreadable or of another version: moved aside to memory/backfill-placements.json.corrupt; every transcript is resolved again');
    const handles = new Map();
    const cutoffs = new Map();
    let ccFailures = 0;
    let hindsightChecked = hindsight.isReady();
    if (!hindsightChecked) line('Hindsight is not ready: already-imported sessions and live overlap are not checked');
    const stopChecking = (e) => {
      throwIfAborted(signal);
      hindsightChecked = false;
      line(`Hindsight could not be read (${e.message}); already-imported sessions and live overlap are not checked from here on`);
    };
    const sessions = [];
    const skipped = [];
    const rows = new Map();
    const totals = { files: files.length, ready: 0, imported: 0, skipped: 0, cached: 0, resolved: 0 };
    const skip = (f, handle, session, code, params = {}) => {
      totals.skipped++;
      skipped.push({
        key: handle ? `${handle}:${f.backingId}` : f.backingId, handle: handle ?? null, backingId: f.backingId,
        ...(session ? { project: session.project, worktree: session.worktree, stage: session.stage } : {}),
        code, message: message(code, params),
      });
    };

    try {
      for (let i = 0; i < files.length; i++) {
        throwIfAborted(signal);
        progress(i, files.length, 'files');
        const f = files[i];
        let st;
        try { st = fs.lstatSync(f.file); } catch (e) { skip(f, null, null, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message }); continue; }
        if (!st.isFile()) { skip(f, null, null, 'TRANSCRIPT_UNREADABLE', { detail: 'not a regular file' }); continue; }
        const stamp = { size: st.size, mtimeMs: st.mtimeMs };
        let entry = placements.get(f.key, stamp);
        if (entry) totals.cached++;
        else {
          const placed = await cc.placeTranscript(f.backingId, { timeoutMs: limits.describeTimeoutMs, signal, handles });
          totals.resolved++;
          if (placed.ccError) {
            if (++ccFailures >= limits.ccFailuresMax) throw new AppError('BACKFILL_CC_UNAVAILABLE', { detail: placed.detail });
          } else ccFailures = 0;
          if (placed.outcome === 'live') { skip(f, placed.handle, null, 'SESSION_LIVE'); continue; }
          if (placed.outcome === 'unplaceable') {
            if (placed.cacheable) placements.set(f.key, { ...stamp, handle: placed.handle ?? null, outcome: 'unplaceable', detail: placed.detail });
            skip(f, placed.handle, null, 'BACKFILL_UNPLACEABLE', { detail: placed.detail });
            continue;
          }
          entry = { ...stamp, handle: placed.handle, outcome: 'placed', session: placed.session, title: placed.title };
          placements.set(f.key, entry);
        }
        if (entry.outcome !== 'placed') { skip(f, entry.handle, null, 'BACKFILL_UNPLACEABLE', { detail: entry.detail }); continue; }
        const { handle, session } = entry;
        const key = `${handle}:${f.backingId}`;
        if (rows.has(key)) continue;

        const aim = await target(list, session);
        if (aim instanceof Skip) { skip(f, handle, session, aim.code, aim.params); continue; }
        if (st.size > limits.fileMaxBytes) { skip(f, handle, session, 'TRANSCRIPT_TOO_LARGE', { size: st.size, max: limits.fileMaxBytes }); continue; }
        if (liveRetainPending(peek, handle)) { skip(f, handle, session, 'LIVE_RETAIN_PENDING'); continue; }

        let cut = null;
        if (hindsightChecked) {
          try {
            if (!cutoffs.has(handle)) cutoffs.set(handle, liveCutoff(list, session, signal));
            cut = await cutoffs.get(handle);
          } catch (e) { stopChecking(e); cutoffs.clear(); }
        }
        if (cut instanceof Skip) { skip(f, handle, session, cut.code, cut.params); continue; }
        // The one read of this file in this scan (none at all when the cached summary applies).
        let summary = cut === null ? entry.summary : undefined;
        if (!summary) {
          try { summary = await summarize(f.file, cut, signal); } catch (e) {
            throwIfAborted(signal);
            skip(f, handle, session, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message });
            continue;
          }
          if (cut === null) { entry.summary = summary; placements.set(f.key, entry); }
        }
        const no = refusal(summary, cut);
        if (no) { skip(f, handle, session, no.code, no.params); continue; }

        let state = { stored: 0, outdated: 0, orphanParts: [] };
        let status = 'ready';
        if (hindsightChecked) {
          try {
            state = await storedState(aim.bank, handle, f.backingId, summary.parts, signal);
            if (state.stored === summary.parts.length && !state.orphanParts.length) status = 'imported';
          } catch (e) { stopChecking(e); }
        }
        const chars = summary.parts.reduce((a, p) => a + p.chars, 0);
        const estimate = sumEstimates(summary.parts.map((p) => estimateDocument(p.chars, llmMode)));
        if (status === 'imported') totals.imported++; else totals.ready++;
        sessions.push({
          key, handle, backingId: f.backingId, project: session.project, worktree: session.worktree, kind: session.kind, stage: session.stage,
          title: entry.title ?? null, firstAt: summary.firstAt, lastAt: summary.lastAt, turns: summary.turns, documents: summary.parts.length, chars,
          bank: aim.bank, scope: aim.scope, status, cutoffAt: cut === null ? null : new Date(cut).toISOString(), untimed: summary.untimed,
          malformed: summary.malformed, oversized: summary.oversized, stored: state.stored, outdated: state.outdated, orphans: state.orphanParts.length, estimate,
        });
        // Exactly what the user confirms: an import acts on this plan or skips the session, never on a recomputed difference.
        rows.set(key, {
          file: f.file, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, session, bank: aim.bank, status,
          plan: { cutoffMs: cut, hashes: summary.parts.map((p) => p.hash), orphanParts: state.orphanParts },
        });
      }
      progress(files.length, files.length, 'files');
    } finally {
      placements.prune(new Set(files.map((f) => f.key)));
      placements.save();
    }

    const ready = sessions.filter((r) => r.status === 'ready');
    const view = {
      scanId: crypto.randomBytes(8).toString('hex'),
      scannedAt: new Date(now()).toISOString(),
      scopesHash: hashOf(list),
      hindsightChecked,
      llm: { mode: llmMode, model: llm.model ?? null },
      basis: BACKFILL_ESTIMATE,
      totals: { ...totals, estimate: sumEstimates(ready.map((r) => r.estimate)) },
      sessions,
      skipped,
    };
    latest = { view, rows };
    const banks = [...new Set(ready.map((r) => r.bank))];
    const summary = `${totals.files} transcripts: ${totals.ready} ready, ${totals.imported} already imported, ${totals.skipped} skipped`;
    line(summary);
    activity.add({ event: 'backfill-scan', outcome: 'ok', count: totals.ready, banks, message: summary });
    return { scanId: view.scanId, totals: view.totals, hindsightChecked };
  }

  /**
   * Stream a transcript again and hand each wanted part, with its turns, to `onPart` (one part's
   * text held at a time). A Skip `TRANSCRIPT_CHANGED` when the file no longer yields every wanted part.
   */
  async function eachWantedPart(file, cutoffMs, wanted, signal, onPart) {
    const splitter = createSplitter(limits.documentMaxChars, (n) => wanted.has(n));
    const seen = new Set();
    const hand = async (part) => { if (part?.turns) { seen.add(part.n); await onPart(part); } };
    for await (const t of transcriptTurns(file, { lineMaxBytes: limits.lineMaxBytes, signal })) {
      if (!beforeCutoff(t, cutoffMs)) continue;
      await hand(splitter.add(t, renderTurn(t)));
    }
    await hand(splitter.end());
    if ([...wanted.keys()].some((n) => !seen.has(n))) throw new Skip('TRANSCRIPT_CHANGED');
  }

  /**
   * Import one session's confirmed plan, adding to `counts` as it goes (so a session that stops
   * part-way still reports what it sent). Throws a Skip, a per-item refusal or a fatal error.
   */
  async function importOne(row, handle, backingId, plan, cut, st, signal, counts) {
    const { bank, session } = row;
    const send = new Map();
    for (let n = 1; n <= plan.parts.length; n++) {
      throwIfAborted(signal);
      const part = plan.parts[n - 1];
      const documentId = backfillDocumentId(handle, backingId, n);
      const doc = await hindsight.getDocument(bank, documentId, { signal });
      if (doc && doc.originalText !== null && contentHash(doc.originalText) === part.hash) { counts.alreadyImported++; continue; }
      const operationId = operationIdFor(bank, documentId, part.firstId, part.lastId, part.hash);
      const status = await hindsight.operationStatus(bank, operationId, { signal });
      if (status === 'failed' || status === 'cancelled') {
        await hindsight.retryOperation(bank, operationId, { signal });
        counts.retried++;
      } else if (status === 'pending' || status === 'processing' || status === 'completed') {
        counts.queued++;
      } else send.set(n, { operationId, replace: !!doc });
    }
    if (send.size) {
      await eachWantedPart(row.file, cut, send, signal, async (part) => {
        throwIfAborted(signal);
        if (part.hash !== plan.parts[part.n - 1].hash) throw new Skip('TRANSCRIPT_CHANGED');
        const { operationId, replace } = send.get(part.n);
        const item = buildRetainItem({
          sessionId: handle, documentId: backfillDocumentId(handle, backingId, part.n), updateMode: 'replace', turns: part.turns, session,
          fallbackTimestamp: new Date(st.mtimeMs).toISOString(), extraContext: CONTEXT_SUFFIX,
          extraMetadata: { origin: 'backfill', segment: backingId, part: String(part.n) },
        });
        await hindsight.retain(bank, item, { operationId, signal, origin: 'backfill' });
        if (replace) counts.replaced++; else counts.sent++;
      });
    }
    // Only the orphans the confirmed scan listed (an earlier import of a longer cut, holding turns
    // live memory now has), highest first: an interruption leaves a lower block the next scan finds.
    for (const n of [...row.plan.orphanParts].sort((a, b) => b - a)) {
      throwIfAborted(signal);
      if (await hindsight.deleteDocument(bank, backfillDocumentId(handle, backingId, n), { signal })) counts.deleted++;
    }
  }

  /** Whether a recomputed plan is exactly the one the scan showed. */
  const samePlan = (confirmed, plan) => plan.parts.length === confirmed.hashes.length && plan.parts.every((p, i) => p.hash === confirmed.hashes[i]);

  async function importSessions({ keys }, { line, progress, signal }) {
    const list = savedScopes();
    const peek = cursors.peeker();
    const result = { sessions: 0, documents: { sent: 0, replaced: 0, alreadyImported: 0, queued: 0, retried: 0, deleted: 0 }, failed: [], skipped: [], banks: [] };
    const banks = new Set();
    const cutoffs = new Map();
    let fatal = null;
    const skip = (key, code, params = {}) => {
      result.skipped.push({ key, code, message: message(code, params) });
      line(`${key}: skipped ${code}`);
    };
    try {
      for (let i = 0; i < keys.length; i++) {
        throwIfAborted(signal);
        progress(i, keys.length, 'sessions');
        const key = keys[i];
        const row = latest.rows.get(key);
        const { session, bank } = row;
        const handle = session.sessionId;
        const backingId = key.slice(handle.length + 1);
        let st;
        try { st = fs.lstatSync(row.file); } catch (e) { skip(key, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message }); continue; }
        // The same regular file, unchanged: a swap (even for a symlink to identical bytes) is a change.
        if (!st.isFile() || st.size !== row.size || st.mtimeMs !== row.mtimeMs || st.dev !== row.dev || st.ino !== row.ino) { skip(key, 'TRANSCRIPT_CHANGED'); continue; }
        if (liveRetainPending(peek, handle)) { skip(key, 'LIVE_RETAIN_PENDING'); continue; }
        if (!cutoffs.has(handle)) cutoffs.set(handle, liveCutoff(list, session, signal));
        const cut = await cutoffs.get(handle);
        if (cut instanceof Skip) { skip(key, cut.code, cut.params); continue; }
        // Act only on the confirmed dry run: a moved cutoff or other content means scan again.
        if (cut !== row.plan.cutoffMs) { skip(key, 'LIVE_CUTOFF_MOVED'); continue; }
        let plan;
        try { plan = await summarize(row.file, cut, signal); } catch (e) {
          throwIfAborted(signal);
          skip(key, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message });
          continue;
        }
        const no = refusal(plan, cut);
        if (no) { skip(key, no.code, no.params); continue; }
        if (!samePlan(row.plan, plan)) { skip(key, 'TRANSCRIPT_CHANGED'); continue; }
        const counts = { sent: 0, replaced: 0, alreadyImported: 0, queued: 0, retried: 0, deleted: 0 };
        const tally = () => { for (const k of Object.keys(counts)) result.documents[k] += counts[k]; };
        try { await importOne(row, handle, backingId, plan, cut, st, signal, counts); } catch (e) {
          tally();
          if (e instanceof Skip) { skip(key, e.code, e.params); continue; }
          if (signal.aborted || !refusedItem(e)) throw e;
          // Hindsight refused this session's item: report it and go on; other failures stop the job.
          result.failed.push({ key, code: e.code, message: e.message });
          activity.add({ event: 'backfill-import', outcome: 'error', sessionId: handle, project: session.project, worktree: session.worktree, stage: session.stage, kind: session.kind, banks: [bank], code: e.code, message: e.message });
          line(`${key}: failed ${e.code} (HTTP ${e.params.status})`);
          continue;
        }
        tally();
        result.sessions++;
        banks.add(bank);
        line(`${key} → ${bank}: ${plan.parts.length} documents (${counts.sent} sent, ${counts.replaced} replaced, ${counts.alreadyImported} already imported, ${counts.queued} already queued, ${counts.retried} retried; ${counts.deleted} orphaned parts deleted)${plan.untimed ? `; ${plan.untimed} turns without a timestamp left out` : ''}`);
      }
      progress(keys.length, keys.length, 'sessions');
      return result;
    } catch (e) {
      fatal = e;
      throw e;
    } finally {
      result.banks = [...banks];
      const d = result.documents;
      const summary = `${signal.aborted ? 'Cancelled: ' : ''}${result.sessions} sessions finished, ${d.sent + d.replaced + d.retried} documents sent (${d.replaced} of them replacing outdated parts), ${d.alreadyImported} already imported, ${d.queued} already queued, ${d.retried} retried, ${d.deleted} orphaned parts deleted, ${result.failed.length} failed, ${result.skipped.length} skipped`;
      line(summary);
      // A cancelled run is not a success; a stopped one is an error.
      const outcome = signal.aborted ? 'skipped' : fatal ? 'error' : 'ok';
      activity.add({ event: 'backfill-import', outcome, count: result.sessions, banks: result.banks, ...(outcome === 'error' ? { code: fatal.code ?? 'JOB_FAILED' } : {}), message: outcome === 'error' ? `${summary}; stopped: ${fatal.message}` : summary });
    }
  }

  return {
    /** The latest scan's view, or null (none since the backend started). */
    latestScan: () => latest?.view ?? null,
    kinds: {
      'backfill-scan': {
        cancellable: true,
        validate(p) {
          const list = savedScopes();
          if (!list.some((sc) => sc.actions.includes('retain'))) throw new AppError('BACKFILL_NO_SCOPES');
          if (!cc.isConfigured()) throw new AppError('BACKFILL_CC_UNAVAILABLE', { detail: 'this backend has no cc to ask (CONDUCTOR_URL is unset)' });
          return { fresh: p.fresh === true };
        },
        run: scan,
      },
      'backfill-import': {
        cancellable: true,
        validate(p) {
          if (p.confirm !== true) throw new AppError('CONFIRMATION_REQUIRED', { expected: 'confirm: true' });
          if (!latest || p.scanId !== latest.view.scanId || hashOf(savedScopes()) !== latest.view.scopesHash) throw new AppError('BACKFILL_STALE');
          // A dry run that could not read Hindsight disclosed neither live overlap nor outdated parts: it cannot be confirmed.
          if (!latest.view.hindsightChecked) throw new AppError('BACKFILL_UNCHECKED');
          if (!Array.isArray(p.sessions) || !p.sessions.length) throw new AppError('BAD_REQUEST', { detail: 'sessions must be a non-empty list of scan keys' });
          const keys = [...new Set(p.sessions)];
          const bad = keys.find((k) => typeof k !== 'string' || latest.rows.get(k)?.status !== 'ready');
          if (bad !== undefined) throw new AppError('BAD_REQUEST', { detail: `${JSON.stringify(bad)} is not a ready session of this scan` });
          if (!hindsight.isReady()) throw new AppError('HINDSIGHT_NOT_READY');
          const chosen = new Set(keys);
          return { keys: latest.view.sessions.map((r) => r.key).filter((k) => chosen.has(k)) };
        },
        run: importSessions,
      },
    },
  };
}
