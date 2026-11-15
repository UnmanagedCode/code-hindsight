// The one hook entry point: `hook.mjs recall|retain|reset`, run by Claude Code. It reads the hook
// input from stdin, asks the plugin backend (through cc's plugin proxy) and, for `recall`, prints
// the context to inject. It ALWAYS exits 0 and never writes stderr, so a down backend, a timeout
// or garbage input can only ever cost a turn its memory. Stop must print nothing (stdout or exit 2
// on Stop would keep the session running).
import { readTranscriptTail, stripInjectedMemory, trimTurnsToBytes } from './transcript.mjs';
import { HOOK_TIMEOUTS, RECALL_QUERY_MAX_CHARS, RETAIN_TAIL_BYTES, TRANSCRIPT_WAIT_MS, forceExitMs } from './limits.mjs';

const env = process.env;
const override = Number(env.CODE_HINDSIGHT_HOOK_TIMEOUT_MS);
const deadline = (event) => (Number.isFinite(override) && override > 0 ? override : HOOK_TIMEOUTS[event]);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function post(base, event, body) {
  const res = await fetch(`${base}/-/hook/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deadline(event)),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The transcript's turns, waiting briefly for the final assistant message to be written, and
 *  adding it as a synthetic turn when it never shows up. */
async function turnsWithFinalMessage(input, waitMs) {
  const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
  const end = Date.now() + waitMs;
  let turns = readTranscriptTail(input.transcript_path);
  const has = () => !last || turns.slice(-8).some((t) => t.role === 'assistant' && t.content.includes(stripInjectedMemory(last).trim()));
  while (!has() && Date.now() < end) {
    await sleep(100);
    turns = readTranscriptTail(input.transcript_path);
  }
  if (!has()) {
    const lastId = turns.length ? turns[turns.length - 1].id : 'none';
    turns.push({ id: `final:${lastId}`, role: 'assistant', content: stripInjectedMemory(last).trim(), timestamp: new Date().toISOString() });
  }
  return turns;
}

async function run(event) {
  const sessionId = env.CC_SESSION_ID;
  const base = env.CODE_HINDSIGHT_HOOK_URL || (env.CONDUCTOR_URL ? `${env.CONDUCTOR_URL.replace(/\/+$/, '')}/plugins/code-hindsight` : '');
  if (!sessionId || !base || !Object.hasOwn(HOOK_TIMEOUTS, event)) return null;
  const input = await readStdin();
  if (event === 'recall') {
    const prompt = stripInjectedMemory(String(input.prompt ?? '')).trim().slice(0, RECALL_QUERY_MAX_CHARS);
    if (!prompt) return null;
    const out = await post(base, 'recall', { sessionId, prompt });
    return typeof out?.context === 'string' && out.context
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.context } })
      : null;
  }
  if (event === 'retain') {
    if (typeof input.transcript_path !== 'string') return null;
    const turns = await turnsWithFinalMessage(input, Math.min(TRANSCRIPT_WAIT_MS, deadline('retain')));
    if (!turns.length) return null;
    await post(base, 'retain', { sessionId, turns: trimTurnsToBytes(turns, RETAIN_TAIL_BYTES) });
    return null;
  }
  await post(base, 'reset', { sessionId });
  return null;
}

const event = process.argv[2];
// Backstop: whatever hangs (stdin, a socket), the process is gone shortly after its deadline.
setTimeout(() => process.exit(0), forceExitMs(deadline(event) ?? 1500)).unref();
let out = null;
try { out = await run(event); } catch { /* a hook failure is a memoryless turn, never an error */ }
if (event === 'recall' && out) process.stdout.write(`${out}\n`, () => process.exit(0));
else process.exit(0);
