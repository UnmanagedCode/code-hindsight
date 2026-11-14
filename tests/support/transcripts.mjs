// Synthetic Claude Code transcripts for the reader and backfill tests: a temp
// `<config dir>/projects/<encoded dir>/<backing id>.jsonl` tree written from line builders.
// Every line is made up here; no real transcript is ever read.
import fs from 'node:fs';
import path from 'node:path';

const j = (o) => JSON.stringify(o);
/** An ISO time `sec` seconds after a fixed start (default 2026-01-01T00:00:00Z). */
export const at = (sec, start = Date.parse('2026-01-01T00:00:00.000Z')) => new Date(start + sec * 1000).toISOString();

export const userLine = (uuid, content, ts, extra = {}) => j({ type: 'user', uuid, sessionId: 'synthetic', ...(ts === null ? {} : { timestamp: ts }), message: { role: 'user', content }, ...extra });
export const assistantLine = (uuid, content, ts, extra = {}) => j({ type: 'assistant', uuid, sessionId: 'synthetic', ...(ts === null ? {} : { timestamp: ts }), message: { role: 'assistant', content }, ...extra });

/** `n` exchanges (user then assistant), uuids `<prefix>u<i>` / `<prefix>a<i>`, one second apart from `fromSec`. */
export function exchanges(n, { prefix = '', fromSec = 0, text = (i, who) => `${who} ${prefix}${i}` } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(userLine(`${prefix}u${i}`, text(i, 'user'), at(fromSec + 2 * i)));
    out.push(assistantLine(`${prefix}a${i}`, [{ type: 'text', text: text(i, 'assistant') }], at(fromSec + 2 * i + 1)));
  }
  return out;
}

/** Every kind of line a transcript holds; only `kept-user`, `kept-asst` (prose) and `kept-asst#0` (an action) are turns. */
export function everyKind() {
  return [
    j({ type: 'session-owner', sessionId: 'synthetic' }),
    userLine('kept-user', 'Please fix the bug <system-reminder>injected</system-reminder>', at(0)),
    assistantLine('kept-asst', [
      { type: 'thinking', thinking: 'THINKING-SECRET' },
      { type: 'text', text: 'Fixing it.' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.js', old_string: 'ARG-SECRET' } },
    ], at(1)),
    userLine('result', [{ type: 'tool_result', tool_use_id: 't1', content: 'RESULT-SECRET' }], at(2)),
    assistantLine('side', 'SIDECHAIN-SECRET', at(3), { isSidechain: true }),
    userLine('meta', 'META-SECRET', at(4), { isMeta: true }),
    userLine('compact', 'COMPACT-SECRET', at(5), { isCompactSummary: true }),
  ];
}

/** A temp Claude config dir; `projects` is the transcripts root the backend reads. */
export function claudeDir(root) {
  const configDir = path.join(root, 'claude-config');
  const projects = path.join(configDir, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return { configDir, projects };
}

/**
 * Write `<projects>/<dir>/<backingId>.jsonl` from lines (joined with newlines, ending with one).
 * `mtimeMs` sets the file's modification time. Returns the file path.
 */
export function writeTranscript(projects, dir, backingId, lines, { mtimeMs, raw } = {}) {
  const d = path.join(projects, dir);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${backingId}.jsonl`);
  fs.writeFileSync(file, raw ?? `${lines.join('\n')}\n`);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}
