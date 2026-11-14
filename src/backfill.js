// The backfill importer: on request, retain past cc sessions' saved Claude Code transcripts into
// the banks their scopes choose. Two job kinds over the shared job runner:
// - `backfill-scan` (a dry run): find transcript files, place each through cc's record (cached in
//   backfillPlacements.js), match scopes, check live memory's overlap and what is already imported,
//   and estimate the LLM tokens. It retains nothing.
// - `backfill-import` (after an explicit confirm): send the chosen sessions, one request at a time.
// It never touches the live `cc-session:<id>` documents or `memory/cursors.json` (read-only `peek`).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { matchScopes, renderBank, withWorkspace } from './scopes.js';
import { buildRetainItem, renderTurn } from './retainItem.js';
import { operationIdFor } from './retainCursor.js';
import { isSessionId } from './ccSession.js';
import { readTranscriptFile } from '../claude/hooks/transcript.mjs';

const MiB = 1024 * 1024;
export const BACKFILL_LIMITS = Object.freeze({
  /** A larger transcript file is skipped without being read. */
  fileMaxBytes: 512 * MiB,
  /** A longer transcript line is dropped while it streams (counted `oversized`). */
  lineMaxBytes: 32 * MiB,
  /** Largest rendered content of one retained document; a session is split into parts at turn boundaries. */
  documentMaxChars: 1_000_000,
  /** Deadline of each describe_session call while scanning. */
  describeTimeoutMs: 15_000,
  /** This many consecutive cc failures abort a scan. */
  ccFailuresMax: 5,
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
 * Turns split into parts at turn boundaries, each part's rendered content at most `maxChars`
 * (a single longer turn is a part of its own). Returns `[{turns, chars}]`.
 */
export function splitParts(turns, maxChars) {
  const parts = [];
  let cur = [];
  let chars = 0;
  for (const t of turns) {
    const len = renderTurn(t).length;
    const next = cur.length ? chars + 1 + len : len;
    if (cur.length && next > maxChars) {
      parts.push({ turns: cur, chars });
      cur = [t];
      chars = len;
    } else {
      cur.push(t);
      chars = next;
    }
  }
  if (cur.length) parts.push({ turns: cur, chars });
  return parts;
}

const parses = (ts) => typeof ts === 'string' && !Number.isNaN(Date.parse(ts));

/** Turns strictly earlier than `cutoffMs` (null: all). Turns without a parseable timestamp are excluded when there is a cutoff. */
function beforeCutoff(turns, cutoffMs) {
  if (cutoffMs === null) return { turns, untimed: 0 };
  let untimed = 0;
  const kept = turns.filter((t) => {
    if (!parses(t.timestamp)) { untimed++; return false; }
    return Date.parse(t.timestamp) < cutoffMs;
  });
  return { turns: kept, untimed };
}

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

/**
 * @param {object} o
 * @param {{get: () => object[]}} o.scopes
 * @param {ReturnType<import('./ccSession.js').createCcClient>} o.cc
 * @param {ReturnType<import('./hindsightClient.js').createHindsightClient>} o.hindsight
 * @param {{peek(sessionId: string): object|undefined}} o.cursors
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

  const read = (file, signal) => readTranscriptFile(file, { lineMaxBytes: limits.lineMaxBytes, signal });

  /** Whether live retain still holds unsent turns of this session (their start is unknown). */
  function liveRetainPending(handle) {
    const c = cursors.peek(handle);
    return !!c && (!!c.inflight || (Array.isArray(c.pending) && c.pending.length > 0));
  }

  /**
   * Where live memory of this session starts: the earliest turn timestamp of its `cc-session:`
   * document across every bank a retain scope renders for it (whether or not that scope matches
   * now: stages and scopes may have changed since). null when there is none; a Skip when it cannot
   * be read. Hindsight failures throw.
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

  function summarize(turns, extra) {
    return {
      turns: turns.length,
      parts: splitParts(turns, limits.documentMaxChars).map((p) => p.chars),
      firstAt: turns.find((t) => parses(t.timestamp))?.timestamp ?? null,
      lastAt: [...turns].reverse().find((t) => parses(t.timestamp))?.timestamp ?? null,
      ...extra,
    };
  }

  async function scan({ fresh }, { line, progress, signal }) {
    const list = savedScopes();
    const llm = settings.get().llm;
    const llmMode = llm.mode;
    const files = listFiles(line);
    progress(0, files.length, 'files');
    if (placements.load({ fresh }).corrupt) line('the placement cache was unreadable: moved aside to memory/backfill-placements.json.corrupt; every transcript is resolved again');
    const handles = new Map();
    const cutoffs = new Map();
    let ccFailures = 0;
    let hindsightChecked = hindsight.isReady();
    if (!hindsightChecked) line('Hindsight is not ready: already-imported sessions and live overlap are not checked');
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
        try { st = fs.statSync(f.file); } catch (e) { skip(f, null, null, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message }); continue; }
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
        let summary = entry.summary;
        if (!summary) {
          let out;
          try { out = await read(f.file, signal); } catch (e) {
            throwIfAborted(signal);
            skip(f, handle, session, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message });
            continue;
          }
          summary = summarize(out.turns, { malformed: out.malformed, oversized: out.oversized });
          entry.summary = summary;
          placements.set(f.key, entry);
        }
        if (!summary.turns) { skip(f, handle, session, 'TRANSCRIPT_EMPTY'); continue; }
        if (liveRetainPending(handle)) { skip(f, handle, session, 'LIVE_RETAIN_PENDING'); continue; }

        let view = { turns: summary.turns, parts: summary.parts, firstAt: summary.firstAt, lastAt: summary.lastAt, untimed: 0 };
        let cutoffAt = null;
        let status = 'ready';
        if (hindsightChecked) {
          try {
            if (!cutoffs.has(handle)) cutoffs.set(handle, liveCutoff(list, session, signal));
            const cut = await cutoffs.get(handle);
            if (cut instanceof Skip) { skip(f, handle, session, cut.code, cut.params); continue; }
            if (cut !== null) {
              const out = await read(f.file, signal);
              const kept = beforeCutoff(out.turns, cut);
              if (!kept.turns.length) { skip(f, handle, session, 'ALREADY_LIVE'); continue; }
              const s = summarize(kept.turns, {});
              view = { turns: s.turns, parts: s.parts, firstAt: s.firstAt, lastAt: s.lastAt, untimed: kept.untimed };
              cutoffAt = new Date(cut).toISOString();
            }
            let present = 0;
            for (let n = 1; n <= view.parts.length; n++) if (await hindsight.getDocument(aim.bank, backfillDocumentId(handle, f.backingId, n), { signal })) present++;
            if (present === view.parts.length) status = 'imported';
          } catch (e) {
            throwIfAborted(signal);
            hindsightChecked = false;
            cutoffs.clear();
            line(`Hindsight could not be read (${e.message}); already-imported sessions and live overlap are not checked from here on`);
          }
        }
        const chars = view.parts.reduce((a, c) => a + c, 0);
        const estimate = sumEstimates(view.parts.map((c) => estimateDocument(c, llmMode)));
        if (status === 'imported') totals.imported++; else totals.ready++;
        sessions.push({
          key, handle, backingId: f.backingId, project: session.project, worktree: session.worktree, kind: session.kind, stage: session.stage,
          title: entry.title ?? null, firstAt: view.firstAt, lastAt: view.lastAt, turns: view.turns, documents: view.parts.length, chars,
          bank: aim.bank, scope: aim.scope, status, cutoffAt, untimed: view.untimed, malformed: summary.malformed, oversized: summary.oversized, estimate,
        });
        rows.set(key, { file: f.file, size: st.size, mtimeMs: st.mtimeMs, session, bank: aim.bank, status });
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

  async function importSessions({ keys }, { line, progress, signal }) {
    const list = savedScopes();
    const result = { sessions: 0, documents: { sent: 0, alreadyImported: 0, queued: 0, retried: 0 }, failed: [], skipped: [], banks: [] };
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
        try { st = fs.statSync(row.file); } catch (e) { skip(key, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message }); continue; }
        if (st.size !== row.size || st.mtimeMs !== row.mtimeMs) { skip(key, 'TRANSCRIPT_CHANGED'); continue; }
        if (liveRetainPending(handle)) { skip(key, 'LIVE_RETAIN_PENDING'); continue; }
        if (!cutoffs.has(handle)) cutoffs.set(handle, liveCutoff(list, session, signal));
        const cut = await cutoffs.get(handle);
        if (cut instanceof Skip) { skip(key, cut.code, cut.params); continue; }
        let out;
        try { out = await read(row.file, signal); } catch (e) {
          throwIfAborted(signal);
          skip(key, 'TRANSCRIPT_UNREADABLE', { detail: e.code ?? e.message });
          continue;
        }
        const kept = beforeCutoff(out.turns, cut);
        if (!kept.turns.length) { skip(key, cut === null ? 'TRANSCRIPT_EMPTY' : 'ALREADY_LIVE'); continue; }
        const parts = splitParts(kept.turns, limits.documentMaxChars);
        const counts = { sent: 0, alreadyImported: 0, queued: 0, retried: 0 };
        try {
          for (let n = 1; n <= parts.length; n++) {
            throwIfAborted(signal);
            const part = parts[n - 1].turns;
            const documentId = backfillDocumentId(handle, backingId, n);
            if (await hindsight.getDocument(bank, documentId, { signal })) { counts.alreadyImported++; continue; }
            const operationId = operationIdFor(bank, documentId, part[0].id, part[part.length - 1].id);
            const status = await hindsight.operationStatus(bank, operationId, { signal });
            if (status === 'failed' || status === 'cancelled') {
              await hindsight.retryOperation(bank, operationId, { signal });
              counts.retried++;
            } else if (status === 'pending' || status === 'processing' || status === 'completed') {
              counts.queued++;
            } else {
              const item = buildRetainItem({
                sessionId: handle, documentId, updateMode: 'replace', turns: part, session,
                fallbackTimestamp: new Date(st.mtimeMs).toISOString(), extraContext: CONTEXT_SUFFIX,
                extraMetadata: { origin: 'backfill', segment: backingId, part: String(n) },
              });
              await hindsight.retain(bank, item, { operationId, signal, origin: 'backfill' });
              counts.sent++;
            }
          }
        } catch (e) {
          const refused = !signal.aborted && e?.code === 'RETAIN_FAILED' && e.params?.status >= 400 && e.params?.status < 500;
          if (!refused) throw e;
          // Hindsight refused this session's item: report it and go on; other failures stop the job.
          result.failed.push({ key, code: e.code, message: e.message });
          activity.add({ event: 'backfill-import', outcome: 'error', sessionId: handle, project: session.project, worktree: session.worktree, stage: session.stage, kind: session.kind, banks: [bank], code: e.code, message: e.message });
          line(`${key}: failed ${e.code} (HTTP ${e.params.status})`);
          continue;
        }
        for (const k of Object.keys(counts)) result.documents[k] += counts[k];
        result.sessions++;
        banks.add(bank);
        line(`${key} → ${bank}: ${parts.length} documents (${counts.sent} sent, ${counts.alreadyImported} already imported, ${counts.queued} already queued, ${counts.retried} retried)${kept.untimed ? `; ${kept.untimed} turns without a timestamp left out` : ''}`);
      }
      progress(keys.length, keys.length, 'sessions');
      return result;
    } catch (e) {
      fatal = e;
      throw e;
    } finally {
      result.banks = [...banks];
      const d = result.documents;
      const summary = `${signal.aborted ? 'Cancelled: ' : ''}${result.sessions} sessions (${d.sent + d.retried} documents) sent, ${d.alreadyImported} already imported, ${d.queued} already queued, ${d.retried} retried, ${result.failed.length} failed, ${result.skipped.length} skipped`;
      line(summary);
      const failed = fatal && !signal.aborted;
      activity.add({ event: 'backfill-import', outcome: failed ? 'error' : 'ok', count: result.sessions, banks: result.banks, ...(failed ? { code: fatal.code ?? 'JOB_FAILED' } : {}), message: failed ? `${summary}; stopped: ${fatal.message}` : summary });
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
