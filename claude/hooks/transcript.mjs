// Claude Code transcript (JSONL) → the turns worth remembering. Mirrors Hindsight's own
// coding-agents reader (`readClaudeTranscript` in core/transcript.ts and the helpers in
// core/transcript-util.ts): user and assistant prose, plus one compact `action` turn per tool
// call (tool name and primary target). Tool results, other tool arguments, thinking, sidechain
// lines, `isMeta` lines and compaction summaries are dropped; injected-memory tags are stripped.
// Pure apart from `readTranscriptTail` (the hook's bounded tail) and `readTranscriptFile` (the
// backend's whole-file read for the backfill importer); imported by the hook, the backend and the tests.
import fs from 'node:fs';

/** Injected context removed from retained text, so a retain never re-ingests its own recall. */
export const MEMORY_TAG_RE =
  /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_pages|hindsight_page_refresh|hindsight_knowledge|hindsight_knowledge_refresh)\b[\s\S]*?<\/\1>/g;

/** Keys tried, in order, to find a tool call's primary target. */
const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'name', 'id'];
export const ACTION_TARGET_CAP = 100;
/** Only this much of a transcript's end is read; a longer file is cut at a line boundary. */
export const TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;

export const stripInjectedMemory = (s) => s.replace(MEMORY_TAG_RE, '');

export function actionLine(tool, input) {
  let target = '';
  if (input && typeof input === 'object') {
    for (const k of TARGET_KEYS) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) { target = v.trim().split('\n')[0]; break; }
    }
  } else if (typeof input === 'string') {
    target = input.trim().split('\n')[0];
  }
  if (target.length > ACTION_TARGET_CAP) target = `${target.slice(0, ACTION_TARGET_CAP)}…`;
  return target ? `${tool} ${target}` : tool;
}

function render(content, type) {
  if (typeof content === 'string') {
    const text = stripInjectedMemory(content).trim();
    return text ? [{ role: type, content: text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const texts = [];
  const actions = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      const t = stripInjectedMemory(b.text).trim();
      if (t) texts.push(t);
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      actions.push({ role: 'action', content: actionLine(b.name, b.input) });
    }
  }
  const out = [];
  const joined = texts.join('\n').trim();
  if (joined) out.push({ role: type, content: joined });
  return out.concat(actions);
}

/**
 * Turns of one transcript line (`index` is its 0-based line number in the file): `[]` for a line
 * that is not a real message, `null` for one that is not a JSON object.
 */
export function parseLine(raw, index) {
  const text = raw.trim();
  if (!text) return [];
  let line;
  try { line = JSON.parse(text); } catch { return null; }
  if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
  if (line.type !== 'user' && line.type !== 'assistant') return [];
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) return [];
  if (!line.message || typeof line.message !== 'object') return [];
  const base = typeof line.uuid === 'string' && line.uuid ? line.uuid : `line-${index}`;
  let actionN = 0;
  return render(line.message.content, line.type).map((r) => ({
    id: r.role === 'action' ? `${base}#${actionN++}` : base,
    role: r.role,
    content: r.content,
    timestamp: typeof line.timestamp === 'string' ? line.timestamp : null,
  }));
}

/**
 * Turns of a transcript's text: `{id, role: 'user'|'assistant'|'action', content, timestamp}`.
 * `id` is the entry's uuid (an action's is `<uuid>#<n>`). Unparsable lines (a partial last line
 * is normal while the file is being written) and lines that are not real messages are skipped.
 */
export function parseTranscript(text) {
  const turns = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) turns.push(...(parseLine(lines[i], i) ?? []));
  return turns;
}

/**
 * Every turn of a transcript file, streamed (never a tail window: a whole session is wanted).
 * Lines are split on the newline byte and decoded only when complete, so a character split across
 * read chunks survives. A line growing past `lineMaxBytes` is skipped while it streams, never
 * buffered whole (`oversized`); a line that is not a JSON object is counted `malformed`. Line
 * numbers are absolute, so ids match `parseTranscript` over the same text. Open and read errors throw.
 * @returns {Promise<{turns: object[], lines: number, malformed: number, oversized: number}>}
 */
export async function readTranscriptFile(file, { lineMaxBytes, signal } = {}) {
  const turns = [];
  let index = 0;
  let malformed = 0;
  let oversized = 0;
  let parts = [];
  let size = 0;
  let skipping = false;
  const finish = () => {
    if (!skipping) {
      const out = parseLine(Buffer.concat(parts, size).toString('utf8'), index);
      if (out === null) malformed++; else turns.push(...out);
    }
    index++;
    parts = [];
    size = 0;
    skipping = false;
  };
  const take = (chunk) => {
    if (skipping) return;
    if (lineMaxBytes !== undefined && size + chunk.length > lineMaxBytes) {
      skipping = true;
      oversized++;
      parts = [];
      size = 0;
      return;
    }
    parts.push(chunk);
    size += chunk.length;
  };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024, signal })) {
    let from = 0;
    for (let nl = chunk.indexOf(0x0a, from); nl >= 0; nl = chunk.indexOf(0x0a, from)) {
      take(chunk.subarray(from, nl));
      finish();
      from = nl + 1;
    }
    if (from < chunk.length) take(chunk.subarray(from));
  }
  if (size > 0 || skipping) finish();
  return { turns, lines: index, malformed, oversized };
}

/** Turns of the transcript file's end; [] when it cannot be read. */
export function readTranscriptTail(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, TRANSCRIPT_READ_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      if (size > len) text = text.slice(text.indexOf('\n') + 1);
      return parseTranscript(text);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** The newest turns whose JSON stays within `maxBytes` (oldest dropped first). */
export function trimTurnsToBytes(turns, maxBytes) {
  let used = 0;
  let from = turns.length;
  while (from > 0) {
    const size = Buffer.byteLength(JSON.stringify(turns[from - 1])) + 1;
    if (used + size > maxBytes) break;
    used += size;
    from--;
  }
  return turns.slice(from);
}
