// server.js as cc runs it (`node server.js`, $PORT, the data dir from the env), over the fake
// docker: it answers health at once, starts Hindsight, and on SIGTERM leaves a detached
// `docker stop` behind and exits well inside cc's grace period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkRoot, fakeEnv, seedDocker, writeSettings, dockerCalls, waitFor, REPO } from './helpers.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// Spec 4: the plugin's containers stop when cc stops (or disables) the backend.
test('node server.js: health at once, Hindsight starting, SIGTERM → detached docker stop + stopping.json', async (t) => {
  const r = mkRoot(t);
  seedDocker(r);
  // Ports nothing listens on, so the health wait just keeps waiting.
  writeSettings(r, { ...DEFAULT_SETTINGS, network: { bindAddress: '127.0.0.1', apiPort: await freePort(), cpPort: await freePort() } });
  const port = await freePort();
  const env = { ...fakeEnv(r), PORT: String(port) };
  delete env.CONDUCTOR_URL;
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));

  await waitFor(() => out.includes('listening'), { timeoutMs: 10_000 });
  assert.equal((await fetch(`http://127.0.0.1:${port}/-/api/health`)).status, 200);
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/-/api/status`)).json()).state === 'starting', { timeoutMs: 10_000 });
  await waitFor(() => dockerCalls(r).filter((a) => a[0] === 'run').length === 2, { timeoutMs: 10_000 });

  const t0 = Date.now();
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 3000, 'exits inside cc\'s SIGKILL grace period');
  const rec = JSON.parse(fs.readFileSync(path.join(r.dataDir, 'stopping.json'), 'utf8'));
  assert.ok(Number.isInteger(rec.pid));
  await waitFor(() => dockerCalls(r).some((a) => a[0] === 'stop'), { timeoutMs: 10_000 });
  assert.deepEqual(dockerCalls(r).find((a) => a[0] === 'stop'), ['stop', '-t', '30', 'code-hindsight-cp', 'code-hindsight-api']);
  assert.match(out, /stopping Hindsight in the background/);
});

test('node server.js refuses to start without an absolute data dir', async () => {
  const env = { ...process.env, PORT: '0', CONDUCTOR_PLUGIN_DATA_DIR: 'relative/dir' };
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((res) => child.on('exit', res));
  assert.notEqual(code, 0);
  assert.match(err, /CONDUCTOR_PLUGIN_DATA_DIR must be set to an absolute path/);
});
