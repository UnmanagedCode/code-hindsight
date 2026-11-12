// tarStream.js: the bundle manifest is appended before the end-of-archive marker and read back
// on the way into `docker load`, whatever the chunking, with PAX sizes and record padding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tarEntry, createTarAppender, createTarScanner } from '../src/tarStream.js';
import { mkRoot } from './helpers.mjs';

function paxEntry(name, data) {
  // A PAX record is "<length> <key>=<value>\n", where <length> counts itself.
  const line = (k, v) => { let n = 0; while (Buffer.byteLength(`${n} ${k}=${v}\n`) !== n) n = Buffer.byteLength(`${n} ${k}=${v}\n`); return `${n} ${k}=${v}\n`; };
  const pax = Buffer.from(line('size', data.length));
  const ph = tarEntry('PaxHeader', pax);
  ph[156] = 'x'.charCodeAt(0);
  fixChecksum(ph);
  // The real entry's header claims size 0; the PAX record carries the true size.
  const real = tarEntry(name, data);
  const h = real.subarray(0, 512);
  h.write(`${'0'.padStart(11, '0')}\0`, 124, 'latin1');
  fixChecksum(h);
  return Buffer.concat([ph, real]);
}
function fixChecksum(h) {
  h.write('        ', 148, 'latin1');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
}

/** An archive like `docker save`'s: entries, two zero blocks, then record padding. */
function archive() {
  const body = Buffer.concat([
    tarEntry('index.json', Buffer.from('{"manifests":[]}')),
    paxEntry('blobs/sha256/aaaa', Buffer.alloc(1300, 7)),
    tarEntry('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}')),
  ]);
  const withEnd = Buffer.concat([body, Buffer.alloc(1024)]);
  return Buffer.concat([withEnd, Buffer.alloc((10240 - (withEnd.length % 10240)) % 10240)]);
}

async function through(transform, input, chunk) {
  const parts = [];
  for (let i = 0; i < input.length; i += chunk) parts.push(input.subarray(i, i + chunk));
  const out = [];
  await pipeline(Readable.from(parts), transform, async function* (src) { for await (const c of src) out.push(c); });
  return Buffer.concat(out);
}

for (const chunk of [1, 7, 511, 512, 4096, 1 << 20]) {
  test(`appended manifest round-trips with ${chunk}-byte chunks`, async () => {
    const manifest = Buffer.from(JSON.stringify({ format: 1, images: [{ ref: 'r', id: 'sha256:x' }] }));
    const out = await through(createTarAppender('code-hindsight-bundle.json', manifest), archive(), chunk);
    let seen = null;
    const again = await through(createTarScanner('code-hindsight-bundle.json', (b) => { seen = b; }), out, chunk);
    assert.deepEqual(again, out, 'the scanner passes bytes through unchanged');
    assert.deepEqual(seen, manifest);
    assert.equal(out.length % 512, 0);
    assert.deepEqual(out.subarray(-1024), Buffer.alloc(1024));
  });
}

test('GNU tar reads the appended archive (when tar is installed)', { skip: spawnSync('tar', ['--version']).status !== 0 && 'no tar' }, async (t) => {
  const r = mkRoot(t);
  const out = await through(createTarAppender('code-hindsight-bundle.json', Buffer.from('{"a":1}')), archive(), 3000);
  const file = path.join(r.root, 'b.tar');
  fs.writeFileSync(file, out);
  const list = spawnSync('tar', ['tf', file], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split('\n'), ['index.json', 'blobs/sha256/aaaa', 'oci-layout', 'code-hindsight-bundle.json']);
  assert.equal(spawnSync('tar', ['xOf', file, 'code-hindsight-bundle.json'], { encoding: 'utf8' }).stdout, '{"a":1}');
  assert.equal(spawnSync('tar', ['xOf', file, 'blobs/sha256/aaaa']).stdout.length, 1300, 'the PAX size was honoured');
});

test('an archive without an end marker is an error', async () => {
  const truncated = archive().subarray(0, 1024);
  await assert.rejects(through(createTarAppender('m.json', Buffer.from('{}')), truncated, 100), /no end-of-archive marker/);
});
