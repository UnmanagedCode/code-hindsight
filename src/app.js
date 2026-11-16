// Builds the backend's state and its one request handler: `/` and the UI's files are the
// shell, `/-/api/*` the plugin's API, and every other path the Hindsight control plane.
import path from 'node:path';
import { API_IMAGES, BUILD_HELPER, CP_IMAGE, RESOURCE_PREFIX, VARIANTS } from './pins.js';
import { createDocker } from './docker.js';
import { createSettingsStore } from './settings.js';
import { createSecretsStore } from './secrets.js';
import { ensurePrivateDir } from './fsPrivate.js';
import { detectBindAddress } from './netDetect.js';
import { fetchCcModels } from './llmEnv.js';
import { resourceNames, ownerId } from './containerSpec.js';
import { createSupervisor } from './supervisor.js';
import { createJobs } from './jobs.js';
import { createCpSession } from './cpSession.js';
import { createCpProxy } from './cpProxy.js';
import { createOllamaDaemon } from './ollamaDaemon.js';
import { createRelayProxy } from './relayProxy.js';
import { createRelayTunnel } from './relayTunnel.js';
import { createRoutes } from './routes.js';
import { createScopesStore } from './scopes.js';
import { createCcClient } from './ccSession.js';
import { createHindsightClient } from './hindsightClient.js';
import { createRetainCursors } from './retainCursor.js';
import { createActivityLog } from './activity.js';
import { createBackfill } from './backfill.js';
import { createPlacementCache } from './backfillPlacements.js';
import { createMemory } from './memory.js';
import { createHookRoutes } from './hookRoutes.js';
import { serveStatic, sendText } from './http.js';

/** cc's row for this plugin (best effort: only the Auto-start hint reads it). */
async function fetchPluginRow(conductorUrl, pluginId) {
  if (!conductorUrl) return null;
  const res = await fetch(new URL(`/api/plugins/${encodeURIComponent(pluginId)}/status`, conductorUrl), { signal: AbortSignal.timeout(5_000) });
  return res.ok ? res.json() : null;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {object} [overrides] collaborators tests replace (env for the docker binaries, the
 *   resource prefix, a bind detector, supervisor timeouts and clock, the Hindsight connection)
 */
export function createApp(config, overrides = {}) {
  const { env = process.env, prefix = RESOURCE_PREFIX, detectBind = detectBindAddress, supervisorOptions = {}, hindsightConnection } = overrides;
  ensurePrivateDir(config.dataDir);
  const runDir = ensurePrivateDir(path.join(config.dataDir, 'run'));
  const settings = createSettingsStore(config.dataDir);
  const secrets = createSecretsStore(config.dataDir);
  secrets.get();
  const names = resourceNames(prefix);
  const owner = ownerId(config.dataDir);
  const docker = createDocker({
    env,
    allowSudo: () => settings.get().docker.allowSudo === true,
    prefix,
    images: [...VARIANTS.map((v) => API_IMAGES[v].ref), CP_IMAGE, BUILD_HELPER],
    runDir,
  });
  const ccModels = () => fetchCcModels(config.conductorUrl);
  const ollamaDaemon = createOllamaDaemon({ url: config.ollamaUrl });
  const relayProxy = createRelayProxy({ key: secrets.get().relayKey, ollamaUrl: config.ollamaUrl, daemon: ollamaDaemon });
  const relayTunnel = createRelayTunnel({ key: secrets.get().relayKey, onSocket: relayProxy.handleSocket, log: (m) => console.error(`code-hindsight: ${m}`) });
  const relay = {
    /** `target` is composeLlmEnv's `relay`: it is set before the tunnel dials, so no request meets a tunnel without one. */
    start: (addr, target) => { relayProxy.setTarget(target); relayTunnel.start(addr); },
    /** The target (and any credential in it) leaves memory with the tunnel. */
    stop: () => { relayTunnel.stop(); relayProxy.setTarget(null); },
    status: () => ({ target: relayProxy.target(), tunnel: relayTunnel.status(), lastForward: relayProxy.lastForward() }),
  };
  let supervisor;
  const cpSession = createCpSession({ target: () => supervisor.cpAddress(), accessKey: () => secrets.get().cpAccessKey });
  supervisor = createSupervisor({ docker, settings, secrets, names, owner, dataDir: config.dataDir, detectBind, fetchCcModels: ccModels, cpSession, relay, ...supervisorOptions });
  const scopes = createScopesStore(config.dataDir);
  const cc = createCcClient({ conductorUrl: config.conductorUrl });
  const activity = createActivityLog({ dataDir: config.dataDir });
  const hindsight = createHindsightClient({ connection: hindsightConnection ?? (() => supervisor.connection()) });
  const cursors = createRetainCursors(config.dataDir);
  const backfill = createBackfill({
    scopes, cc, hindsight, cursors, activity, settings,
    placements: createPlacementCache(config.dataDir),
    transcriptsRoot: config.claudeProjectsDir,
  });
  const jobs = createJobs({ docker, supervisor, names, owner, dataDir: config.dataDir, kinds: backfill.kinds });
  const cpProxy = createCpProxy({ target: supervisor.cpTarget, session: cpSession, notReadyError: supervisor.notReadyError });
  const memory = createMemory({ scopes, cc, activity, hindsight, cursors });
  const hookRoutes = createHookRoutes({ memory });
  const api = createRoutes({
    supervisor, jobs, docker, settings, secrets, fetchCcModels: ccModels, scopes, activity, cc, backfill,
    fetchPluginRow: () => fetchPluginRow(config.conductorUrl, config.pluginId),
    detectBind, containerNames: { api: names.api, cp: names.cp, relay: names.relay }, ollamaDaemon, relayProxy,
  });

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://plugin.local'); } catch { return sendText(res, 400, 'Bad request'); }
    const p = url.pathname;
    if (p.startsWith('/-/api/')) return api(req, res, url);
    if (p.startsWith('/-/hook/') || p === '/-/mcp') return hookRoutes(req, res, url);
    if (p.startsWith('/-/')) return sendText(res, 404, 'Not found');
    // The host URLs exist only under cc; standalone they are a real 404.
    if (p === '/pluginBridge.js' || p === '/pluginTheme.css') return sendText(res, 404, 'Not found');
    if (serveStatic(req, res, p, config.distDir)) return undefined;
    return cpProxy(req, res);
  }

  return {
    handle: (req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});
      handle(req, res).catch((e) => {
        console.error('code-hindsight: request failed:', e);
        if (!res.headersSent) sendText(res, 500, 'Internal error'); else res.destroy();
      });
    },
    supervisor, jobs, docker, settings, secrets, names, owner, cpSession, scopes, memory, activity, backfill,
  };
}
