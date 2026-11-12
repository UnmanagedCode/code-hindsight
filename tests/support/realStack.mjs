// Boots a real Hindsight stack through createApp for the gated real-docker tests: a throwaway
// `code-hindsight-test-<rand>` prefix, random host ports, a temp data dir, the locally present
// pinned images (never pulled). Everything the stack created is removed in `t.after`, even on
// failure; other containers, volumes and networks are never touched.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../../src/app.js';
import { API_IMAGES, CP_IMAGE } from '../../src/pins.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { mkRoot, writeSettings } from '../helpers.mjs';

export const REAL = process.env.RUN_REAL_DOCKER === '1';

/** `docker <args>` the way the plugin would run it here (direct, else sudo -n). */
export function hostDocker(args) {
  let r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && /permission denied/i.test(r.stderr)) r = spawnSync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8' });
  return r;
}

/** Why the real stack cannot run here, or null. */
export function realSkipReason(variant = 'full') {
  if (!REAL) return 'set RUN_REAL_DOCKER=1 to run against the real Docker daemon';
  for (const ref of [API_IMAGES[variant].ref, CP_IMAGE]) {
    if (hostDocker(['image', 'inspect', ref]).status !== 0) return `image ${ref} is not present locally (pull/build/import it first; tests never pull)`;
  }
  return null;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{settings?: object, secrets?: object, distDir?: string}} [o]
 */
export async function bootRealStack(t, { settings = {}, secrets = null, distDir } = {}) {
  const prefix = `code-hindsight-test-${crypto.randomBytes(3).toString('hex')}`;
  const r = mkRoot(t);
  const port = () => 30000 + crypto.randomInt(0, 9999);
  const s = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...settings };
  s.network = { bindAddress: null, apiPort: port(), cpPort: port() };
  writeSettings(r, s);
  const config = { port: 0, dataDir: r.dataDir, conductorUrl: null, pluginId: 'code-hindsight', distDir: distDir ?? `${r.root}/no-dist` };
  const apps = [];
  const servers = [];
  const make = async () => {
    const app = createApp(config, { prefix });
    const server = http.createServer(app.handle);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    apps.push(app);
    servers.push(server);
    return { app, url: `http://127.0.0.1:${server.address().port}` };
  };
  t.after(() => {
    for (const s2 of servers) { s2.closeAllConnections(); s2.close(); }
    for (const role of ['cp', 'api']) hostDocker(['rm', '-f', `${prefix}-${role}`]);
    hostDocker(['network', 'rm', `${prefix}-net`]);
    hostDocker(['volume', 'rm', `${prefix}-data`]);
  });
  const first = await make();
  if (secrets) first.app.secrets.setUserSecrets(secrets);
  // A fresh data dir trusts no CP image yet: confirm the local one, as a user would.
  const cpId = hostDocker(['image', 'inspect', '-f', '{{.Id}}', CP_IMAGE]).stdout.trim();
  const trusted = await first.app.jobs.start('trust-cp', { confirm: cpId }).done;
  if (trusted.state !== 'done') throw new Error(`trust-cp failed: ${JSON.stringify(trusted.error)}`);
  return { prefix, r, ...first, again: make };
}

/** A keyed JSON request to the Hindsight API. */
export async function hindsightApi(conn, method, p, body, { key = conn.apiKey } = {}) {
  const res = await fetch(`${conn.apiUrl}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
