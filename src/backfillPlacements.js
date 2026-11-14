// The backfill importer's placement cache (`memory/backfill-placements.json`, 0600): what cc said
// about each saved transcript file, and the parse summary of the file, keyed by
// `<dir>/<backingId>.jsonl` and valid only while the file's size and mtime are unchanged. It makes
// a re-scan ask cc and read only the files that are new or changed. Never holds transcript text.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const PLACEMENTS_VERSION = 2;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createPlacementCache(dataDir) {
  const file = path.join(dataDir, 'memory', 'backfill-placements.json');
  let files = Object.create(null);

  return {
    file,
    /**
     * Read the file for a scan (`fresh`: start empty, ignoring it). A file unreadable as a whole, or
     * of another `PLACEMENTS_VERSION`, is moved aside to `.corrupt` (replacing an older one) and the
     * scan starts empty: it is a cache, rebuilt from cc and the transcripts.
     * @returns {{corrupt: boolean}}
     */
    load({ fresh = false } = {}) {
      files = Object.create(null);
      if (fresh) return { corrupt: false };
      let raw;
      try { raw = readJsonFile(file, null); } catch (e) { if (!(e instanceof SyntaxError)) throw e; raw = undefined; }
      if (raw === null) return { corrupt: false };
      if (!isObj(raw) || raw.version !== PLACEMENTS_VERSION || !isObj(raw.files)) {
        fs.renameSync(file, `${file}.corrupt`);
        return { corrupt: true };
      }
      for (const [k, v] of Object.entries(raw.files)) if (isObj(v)) files[k] = v;
      return { corrupt: false };
    },
    /** The entry for `key` when the file still has this size and mtime, else undefined. */
    get(key, { size, mtimeMs }) {
      const e = Object.hasOwn(files, key) ? files[key] : undefined;
      return e && e.size === size && e.mtimeMs === mtimeMs ? e : undefined;
    },
    set(key, entry) { files[key] = entry; },
    /** Forget every file not in `keep` (files that no longer exist). */
    prune(keep) { for (const k of Object.keys(files)) if (!keep.has(k)) delete files[k]; },
    save() { writePrivateFileAtomic(file, JSON.stringify({ version: PLACEMENTS_VERSION, files })); },
  };
}
