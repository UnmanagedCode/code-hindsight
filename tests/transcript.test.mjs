// claude/hooks/transcript.mjs against the behavior of Hindsight's own Claude transcript reader
// (coding-agents core/transcript.ts, transcript-util.ts): what is kept, what is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot } from './helpers.mjs';
import { parseTranscript, readTranscriptTail, readTranscriptFile, transcriptTurns, trimTurnsToBytes, ACTION_TARGET_CAP, TRANSCRIPT_READ_BYTES } from '../claude/hooks/transcript.mjs';
import { everyKind, exchanges, userLine } from './support/transcripts.mjs';

const j = (o) => JSON.stringify(o);
const user = (uuid, content, extra = {}) => j({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content }, ...extra });
const asst = (uuid, content, extra = {}) => j({ type: 'assistant', uuid, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content }, ...extra });

test('user and assistant prose are kept with the entry uuid and timestamp; everything else a transcript holds is dropped', () => {
  const text = [
    j({ type: 'session-owner', sessionId: 'x' }),
    j({ type: 'attachment', attachment: { type: 'hook_additional_context' } }),
    user('u1', 'Please fix the bug'),
    asst('a1', [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Fixing it.' }]),
    j({ type: 'last-prompt', lastPrompt: 'x' }),
  ].join('\n');
  assert.deepEqual(parseTranscript(text), [
    { id: 'u1', role: 'user', content: 'Please fix the bug', timestamp: '2026-01-01T00:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: 'Fixing it.', timestamp: '2026-01-01T00:00:01.000Z' },
  ]);
});

test('isMeta lines, sidechain lines and compaction summaries are dropped', () => {
  const text = [
    user('m', 'meta caveat', { isMeta: true }),
    asst('s', 'sub-agent chatter', { isSidechain: true }),
    user('c', 'This session is being continued... (summary)', { isCompactSummary: true }),
    user('real', 'real prompt'),
  ].join('\n');
  assert.deepEqual(parseTranscript(text).map((t) => t.id), ['real']);
});

test('tool results are dropped; each tool call is one action turn naming the tool and its primary target, capped', () => {
  const long = `${'x'.repeat(ACTION_TARGET_CAP + 50)}`;
  const text = [
    asst('a1', [
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.js', old_string: 'secret old', new_string: 'secret new' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls -la\nsecond line' } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: long } },
      { type: 'tool_use', id: 't4', name: 'Mystery', input: { weird: 1 } },
    ]),
    user('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'OUTPUT SECRET' }]),
  ].join('\n');
  const turns = parseTranscript(text);
  assert.deepEqual(turns.map((t) => [t.id, t.role, t.content.slice(0, 20)]), [
    ['a1', 'assistant', 'Looking.'],
    ['a1#0', 'action', 'Edit src/a.js'],
    ['a1#1', 'action', 'Bash ls -la'],
    ['a1#2', 'action', `Bash ${'x'.repeat(15)}`],
    ['a1#3', 'action', 'Mystery'],
  ]);
  assert.equal(turns[3].content, `Bash ${'x'.repeat(ACTION_TARGET_CAP)}…`);
  assert.doesNotMatch(JSON.stringify(turns), /secret|OUTPUT/);
});

test('injected memory, system-reminder and task-notification blocks are stripped and the rest of the message kept', () => {
  const text = [
    user('u1', 'before <hindsight_memory>\nnotes\n</hindsight_memory> after <system-reminder>x</system-reminder>'),
    user('u2', '<task-notification>done</task-notification>'),
    asst('a1', [{ type: 'text', text: '<relevant_memories>old</relevant_memories>' }]),
  ].join('\n');
  const turns = parseTranscript(text);
  assert.deepEqual(turns.map((t) => [t.id, t.content.replace(/\s+/g, ' ')]), [['u1', 'before after']]);
});

test('a partial or corrupt line is skipped; a missing uuid still yields a stable id; an unreadable file yields nothing', (t) => {
  const text = `${user('u1', 'one')}\nnot json\n${j(null)}\n${j({ type: 'user', message: { content: 'no uuid' } })}\n{"type":"user","uuid":"cut","mess`;
  assert.deepEqual(parseTranscript(text).map((x) => x.id), ['u1', 'line-3']);
  assert.deepEqual(readTranscriptTail(path.join(mkRoot(t).root, 'missing.jsonl')), []);
});

test('a transcript longer than the read window is read from a line boundary at its end', (t) => {
  const file = path.join(mkRoot(t).root, 't.jsonl');
  const filler = user('f', 'x'.repeat(1000));
  fs.writeFileSync(file, `${Array.from({ length: 9000 }, () => filler).join('\n')}\n${user('last', 'the end')}\n`);
  const turns = readTranscriptTail(file);
  assert.equal(turns.at(-1).id, 'last');
  assert.ok(turns.length < 9001 && turns.length > 1000);
});

test('trimTurnsToBytes keeps the newest turns that fit', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, role: 'user', content: 'x'.repeat(100), timestamp: null }));
  const trimmed = trimTurnsToBytes(turns, 500);
  assert.ok(trimmed.length > 0 && trimmed.length < 10);
  assert.equal(trimmed.at(-1).id, 'u9');
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 500 + trimmed.length);
});

// The backfill importer's whole-file reader (A2/A3: a backfilled session reads exactly as live retain would).

// A2 / invariant: backfill reads a whole session, never a tail window, with parseTranscript's ids.
test('readTranscriptFile reads a file larger than TRANSCRIPT_READ_BYTES whole and yields the same turns as parseTranscript', async (t) => {
  const file = path.join(mkRoot(t).root, 'big.jsonl');
  const filler = 'x'.repeat(1000);
  const lines = [user('first', 'the start'), ...Array.from({ length: 9000 }, (_, i) => user(`f${i}`, filler)), j({ type: 'user', message: { content: 'no uuid' } }), user('last', 'the end')];
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(file, text);
  assert.ok(fs.statSync(file).size > TRANSCRIPT_READ_BYTES);
  const out = await readTranscriptFile(file);
  assert.deepEqual(out.turns, parseTranscript(text));
  assert.equal(out.turns[0].id, 'first');
  assert.equal(out.turns.at(-2).id, 'line-9001', 'a line without a uuid gets the same absolute line id');
  assert.equal(out.turns.at(-1).id, 'last');
  assert.deepEqual([out.malformed, out.oversized], [0, 0]);
});

// A2 / invariant: UTF-8 is decoded per complete line, so a character split across read chunks survives.
test('a multi-byte character split across read chunks survives', async (t) => {
  const file = path.join(mkRoot(t).root, 'utf8.jsonl');
  const head = user('u1', 'PAD');
  // Pad the first line so the 3-byte "€" in the second line straddles the 64 KiB chunk boundary.
  const second = (pad) => user('u2', `${'y'.repeat(pad)}€ and ünïcödé`);
  const prefixBytes = Buffer.byteLength(`${head}\n`) + Buffer.byteLength(second(0).split('€')[0]);
  const pad = 64 * 1024 - 1 - prefixBytes;
  const text = `${head}\n${second(pad)}\n`;
  const euroAt = Buffer.from(text).indexOf(Buffer.from('€'));
  assert.ok(euroAt < 64 * 1024 && euroAt + 3 > 64 * 1024, 'the character straddles the chunk boundary');
  fs.writeFileSync(file, text);
  const out = await readTranscriptFile(file);
  assert.equal(out.turns[1].content, `${'y'.repeat(pad)}€ and ünïcödé`);
});

// A2 / invariant: per-line memory is bounded; bad lines are counted, never fatal, and later lines still parse.
test('malformed lines are skipped and counted; a line over lineMaxBytes is dropped without buffering and counted oversized', async (t) => {
  const file = path.join(mkRoot(t).root, 'bad.jsonl');
  const huge = user('huge', 'z'.repeat(300 * 1024));
  fs.writeFileSync(file, [user('u1', 'one'), 'not json', 'null', '[1,2]', huge, user('u2', 'two'), '{"type":"user","uuid":"cut","mess'].join('\n'));
  const out = await readTranscriptFile(file, { lineMaxBytes: 4096 });
  assert.deepEqual(out.turns.map((x) => x.id), ['u1', 'u2']);
  assert.equal(out.malformed, 4, 'not json, null, an array, and the trailing partial line without a newline');
  assert.equal(out.oversized, 1);
  assert.equal(out.lines, 7);
  await assert.rejects(readTranscriptFile(path.join(mkRoot(t).root, 'missing.jsonl')), { code: 'ENOENT' });
});

// A2 / invariant: the same keep/drop rules as live retain (Hindsight's coding-agents reader).
test('sidechain, meta, compact-summary, thinking and tool_result content never reach the turns', async (t) => {
  const file = path.join(mkRoot(t).root, 'kinds.jsonl');
  fs.writeFileSync(file, `${[...everyKind(), ...exchanges(1)].join('\n')}\n`);
  const out = await readTranscriptFile(file);
  assert.deepEqual(out.turns.map((x) => [x.id, x.role]), [['kept-user', 'user'], ['kept-asst', 'assistant'], ['kept-asst#0', 'action'], ['u0', 'user'], ['a0', 'assistant']]);
  assert.doesNotMatch(JSON.stringify(out.turns), /SECRET|injected/);
  assert.equal(userLine('x', 'y', null).includes('timestamp'), false, 'the fixture can write a line without a timestamp');
});

// A6 / invariant: Cancel reaches the reader; a read stops when its signal aborts, before or during it.
test('readTranscriptFile and transcriptTurns stop with an AbortError when their signal aborts', async (t) => {
  const file = path.join(mkRoot(t).root, 'abort.jsonl');
  fs.writeFileSync(file, `${Array.from({ length: 2000 }, (_, i) => user(`u${i}`, 'x'.repeat(200))).join('\n')}\n`);
  await assert.rejects(readTranscriptFile(file, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const ac = new AbortController();
  const seen = [];
  await assert.rejects((async () => {
    for await (const turn of transcriptTurns(file, { signal: ac.signal })) { seen.push(turn.id); ac.abort(); }
  })(), { name: 'AbortError' });
  assert.ok(seen.length >= 1 && seen.length < 2000, `stopped after ${seen.length} turns`);
});

// A6 / invariant: a symlink in place of a transcript is never followed.
test('transcriptTurns refuses to read through a symlink', async (t) => {
  const root = mkRoot(t).root;
  const target = path.join(root, 'target.jsonl');
  fs.writeFileSync(target, `${user('u1', 'one')}\n`);
  const link = path.join(root, 'link.jsonl');
  fs.symlinkSync(target, link);
  await assert.rejects(readTranscriptFile(link), { code: 'ELOOP' });
});
