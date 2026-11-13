// The memory activity log: every recall, retain and refusal, newest first in the UI. A ring buffer
// in memory (rebuilt from the file at start) plus `logs/memory.jsonl`, rotated at a size cap with
// one `.1` kept. Entries carry ids, project, stage, bank names, counts and error text; they never
// carry prompt or memory text.
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from './fsPrivate.js';

export const ACTIVITY_LIMITS = Object.freeze({ ringSize: 500, rotateBytes: 1024 * 1024, messageMax: 300 });
const FIELDS = ['event', 'outcome', 'sessionId', 'project', 'worktree', 'stage', 'kind', 'banks', 'count', 'code', 'message'];

export function createActivityLog({ dataDir, now = () => Date.now(), log = console.error }) {
  const dir = ensurePrivateDir(path.join(dataDir, 'logs'));
  const file = path.join(dir, 'memory.jsonl');
  let ring = [];
  try {
    ring = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-ACTIVITY_LIMITS.ringSize).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { /* no log yet */ }

  return {
    /** Record one entry; only the known fields are kept. Never throws. */
    add(entry) {
      const e = { at: new Date(now()).toISOString() };
      for (const k of FIELDS) if (entry[k] !== undefined && entry[k] !== null) e[k] = entry[k];
      if (typeof e.message === 'string') e.message = e.message.slice(0, ACTIVITY_LIMITS.messageMax);
      ring.push(e);
      if (ring.length > ACTIVITY_LIMITS.ringSize) ring = ring.slice(-ACTIVITY_LIMITS.ringSize);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size >= ACTIVITY_LIMITS.rotateBytes) fs.renameSync(file, `${file}.1`);
        fs.appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
      } catch (err) {
        log(`code-hindsight: could not write the memory activity log: ${err?.message}`);
      }
    },
    /** Newest first. */
    list: () => [...ring].reverse(),
  };
}
