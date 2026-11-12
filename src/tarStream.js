// Streaming tar helpers for image bundles: append one file to the archive `docker save`
// writes, and pick that file out of an archive on its way into `docker load`. `docker load`
// ignores a root file it does not know (measured), so the bundle stays loadable as is.
import { Transform } from 'node:stream';

const BLOCK = 512;
const MAX_ENTRY = 64 * 1024;

function readSize(h) {
  const field = h.subarray(124, 136);
  if (field[0] & 0x80) {
    let n = 0n; // base-256, big-endian after the marker bit
    for (let i = 1; i < field.length; i++) n = (n << 8n) | BigInt(field[i]);
    return Number(n);
  }
  const s = field.toString('latin1').replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function readName(h) {
  const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const ustar = h.subarray(257, 262).toString('latin1') === 'ustar';
  const prefix = ustar ? h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : '';
  return prefix ? `${prefix}/${name}` : name;
}

/** One regular-file entry: ustar header, data, padding. */
export function tarEntry(name, data, mtime = Math.floor(Date.now() / 1000)) {
  if (Buffer.byteLength(name) > 100) throw new Error('tar entry name too long');
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write(`${mtime.toString(8).padStart(11, '0')}\0`, 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write('0', 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return Buffer.concat([h, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

/**
 * Walks a tar stream block by block. `feed(chunk)` returns how many bytes of the stream so far
 * are fully classified (a header block counts only once complete). Callbacks: `onHeader(name,
 * size)` per entry (PAX headers applied, not reported), `onData(part)` for its data, and
 * `onEnd(offset)` at the first all-zero header block, with that block's stream offset.
 */
function tarWalker({ onHeader = () => {}, onData = () => {}, onEnd = () => {} }) {
  let pending = Buffer.alloc(0);
  let base = 0; // stream offset of pending[0]
  let remaining = 0;
  let padding = 0;
  let paxBuf = null;
  let paxGlobal = false;
  let nextSize = null;
  let ended = false;
  return function feed(chunk) {
    if (ended) return base + pending.length;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (remaining > 0 || padding > 0) {
        const avail = pending.length - off;
        if (avail === 0) break;
        if (remaining > 0) {
          const n = Math.min(remaining, avail);
          const part = pending.subarray(off, off + n);
          if (paxBuf) paxBuf.push(part); else onData(part);
          off += n;
          remaining -= n;
          if (remaining === 0 && paxBuf) {
            const m = /(?:^|\n)\d+ size=(\d+)\n/.exec(Buffer.concat(paxBuf).toString('utf8'));
            if (m && !paxGlobal) nextSize = Number(m[1]);
            paxBuf = null;
          }
        } else {
          const n = Math.min(padding, avail);
          off += n;
          padding -= n;
        }
        continue;
      }
      if (pending.length - off < BLOCK) break;
      const h = pending.subarray(off, off + BLOCK);
      if (h.every((b) => b === 0)) { ended = true; onEnd(base + off); break; }
      off += BLOCK;
      const type = String.fromCharCode(h[156]);
      let size = readSize(h);
      if (type === 'x' || type === 'g') {
        paxBuf = [];
        paxGlobal = type === 'g';
      } else if (nextSize !== null) {
        size = nextSize;
        nextSize = null;
      }
      remaining = size;
      padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (type !== 'x' && type !== 'g') onHeader(readName(h), size);
    }
    base += off;
    pending = pending.subarray(off);
    return base;
  };
}

/** Pass a tar archive through, adding `name` (with `data`) before its end-of-archive marker. */
export function createTarAppender(name, data) {
  let end = null;
  const feed = tarWalker({ onEnd: (offset) => { end = offset; } });
  let unsent = Buffer.alloc(0);
  let unsentBase = 0;
  let done = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (done) return cb();
      unsent = unsent.length ? Buffer.concat([unsent, chunk]) : chunk;
      const classified = feed(chunk);
      const upTo = end ?? classified;
      const n = upTo - unsentBase;
      if (n > 0) {
        this.push(unsent.subarray(0, n));
        unsent = unsent.subarray(n);
        unsentBase += n;
      }
      if (end !== null) {
        this.push(tarEntry(name, data));
        this.push(Buffer.alloc(BLOCK * 2));
        done = true;
        unsent = Buffer.alloc(0);
      }
      cb();
    },
    flush(cb) {
      cb(done ? undefined : new Error('not a complete tar archive (no end-of-archive marker)'));
    },
  });
}

/** Pass a tar archive through unchanged, handing `name`'s content (≤ 64 KiB) to `onEntry`. */
export function createTarScanner(name, onEntry) {
  let parts = null;
  let want = 0;
  let got = 0;
  const feed = tarWalker({
    onHeader: (n, size) => {
      parts = n === name && size <= MAX_ENTRY ? [] : null;
      want = size;
      got = 0;
      if (parts && size === 0) { onEntry(Buffer.alloc(0)); parts = null; }
    },
    onData: (part) => {
      if (!parts) return;
      parts.push(part);
      got += part.length;
      if (got === want) { onEntry(Buffer.concat(parts)); parts = null; }
    },
  });
  return new Transform({ transform(chunk, _e, cb) { feed(chunk); cb(null, chunk); } });
}
