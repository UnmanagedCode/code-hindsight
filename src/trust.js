// Which images may run. The official API images and the build helper are trusted only by a
// pinned ID (pins.js). The control-plane image is built here, so its ID is recorded when a
// build succeeds (trust on first use); any other CP image ID — an import, a retag — runs only
// after the user confirms that exact ID.
import path from 'node:path';
import { API_IMAGES, BUILD_HELPER } from './pins.js';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const isPinnedApiImage = (variant, id) => API_IMAGES[variant].ids.includes(id);
export const isPinnedHelper = (id) => BUILD_HELPER.ids.includes(id);
export const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** The trusted CP image ID (`trusted-cp.json` in the data dir). */
export function createCpTrust(dataDir) {
  const file = path.join(dataDir, 'trusted-cp.json');
  return {
    file,
    /** {id, source: 'build'|'confirmed', at} or null */
    get: () => readJsonFile(file, null),
    set(id, source) {
      if (!IMAGE_ID_RE.test(id)) throw new Error(`not an image ID: ${id}`);
      writePrivateFileAtomic(file, JSON.stringify({ id, source, at: new Date().toISOString() }));
    },
  };
}
