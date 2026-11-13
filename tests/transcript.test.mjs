// claude/hooks/transcript.mjs against the behavior of Hindsight's own Claude transcript reader
// (coding-agents core/transcript.ts, transcript-util.ts): what is kept, what is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRoot } from './helpers.mjs';
import { parseTranscript, readTranscriptTail, trimTurnsToBytes, ACTION_TARGET_CAP } from '../claude/hooks/transcript.mjs';

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
