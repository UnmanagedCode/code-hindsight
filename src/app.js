// Builds the backend's state and its one request handler: `/` and the UI's files are the
// shell, `/-/api/*` the plugin's API, and every other path the Hindsight control plane.
import path from 'node:path';
import { API_IMAGES, BUILD_HELPER, CP_IMAGE, RESOURCE_PREFIX, VARIANTS } from './pins.js';
import { createCpTrust } from './trust.js';
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
import { createRoutes } from './routes.js';
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
 *   resource prefix, a bind detector, supervisor timeouts and clock)
 */
export function createApp(config, overrides = {}) {
  const { env = process.env, prefix = RESOURCE_PREFIX, detectBind = detectBindAddress, supervisorOptions = {} } = overrides;
  ensurePrivateDir(config.dataDir);
  const runDir = ensurePrivateDir(path.join(config.dataDir, 'run'));
  const settings = createSettingsStore(config.dataDir);
  const secrets = createSecretsStore(config.dataDir);
  secrets.get();
  const cpTrust = createCpTrust(config.dataDir);
  const names = resourceNames(prefix);
  const owner = ownerId(config.dataDir);
  const docker = createDocker({
    env,
    allowSudo: () => settings.get().docker.allowSudo === true,
    prefix,
    images: [...VARIANTS.map((v) => API_IMAGES[v].ref), CP_IMAGE, BUILD_HELPER.ref],
    runDir,
  });
  const ccModels = () => fetchCcModels(config.conductorUrl);
  let supervisor;
  const cpSession = createCpSession({ target: () => supervisor.cpAddress(), accessKey: () => secrets.get().cpAccessKey });
  supervisor = createSupervisor({ docker, settings, secrets, cpTrust, names, owner, dataDir: config.dataDir, detectBind, fetchCcModels: ccModels, cpSession, ...supervisorOptions });
  const jobs = createJobs({ docker, supervisor, cpTrust, names, owner, dataDir: config.dataDir });
  const cpProxy = createCpProxy({ target: supervisor.cpTarget, session: cpSession, notReadyError: supervisor.notReadyError });
  const api = createRoutes({
    supervisor, jobs, docker, settings, secrets, fetchCcModels: ccModels,
    fetchPluginRow: () => fetchPluginRow(config.conductorUrl, config.pluginId),
    detectBind, containerNames: { api: names.api, cp: names.cp },
  });

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://plugin.local'); } catch { return sendText(res, 400, 'Bad request'); }
    const p = url.pathname;
    if (p.startsWith('/-/api/')) return api(req, res, url);
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
    supervisor, jobs, docker, settings, secrets, cpTrust, names, owner, cpSession,
  };
}
