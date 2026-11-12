// Keys (secrets.json, 0600): the API key and CP access key this plugin generates once, and the
// LLM / embeddings keys the user enters. No route returns a value; the UI sees only whether
// each write-only key is set.
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

/** Keys the user sets through Settings (write-only). */
export const USER_SECRETS = Object.freeze(['llmApiKey', 'embeddingsApiKey']);
const GENERATED = Object.freeze(['apiKey', 'cpAccessKey']);

export function createSecretsStore(dataDir) {
  const file = path.join(dataDir, 'secrets.json');
  let current = null;

  function load() {
    if (current) return current;
    const stored = readJsonFile(file, {});
    let changed = false;
    for (const k of GENERATED) {
      if (typeof stored[k] !== 'string' || stored[k].length < 32) {
        stored[k] = crypto.randomBytes(32).toString('hex');
        changed = true;
      }
    }
    if (changed) writePrivateFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
    current = stored;
    return current;
  }

  return {
    file,
    /** All keys (generated on first use). Callers pass them only into container env. */
    get: () => ({ ...load() }),
    /** Whether each user key is set. */
    has: () => Object.fromEntries(USER_SECRETS.map((k) => [k, typeof load()[k] === 'string' && load()[k] !== ''])),
    /**
     * Set or clear user keys: a string sets, null clears, an absent key keeps.
     * @param {Record<string, string|null|undefined>} patch
     */
    setUserSecrets(patch) {
      const next = { ...load() };
      for (const k of USER_SECRETS) {
        if (patch[k] === undefined) continue;
        if (patch[k] === null || patch[k] === '') delete next[k];
        else next[k] = String(patch[k]);
      }
      writePrivateFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
      current = next;
    },
  };
}
