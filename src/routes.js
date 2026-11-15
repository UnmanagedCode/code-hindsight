// The plugin's own JSON API under /-/api/. Every state-changing route requires a JSON body
// (or, for an image upload, an octet-stream from this page), so another site cannot drive it.
import fs from 'node:fs';
import { AppError, describeError } from './errors.js';
import { sendJson, readJson, securityHeaders } from './http.js';
import { isCrossSite } from './cpProxy.js';
import { validateSettings, keyEndpoints, LLM_MAX_CONCURRENT_MAX, LLM_MODES, EMBEDDINGS_PROVIDERS, RERANKER_PROVIDERS, SLIM_REFUSED, DEFAULT_SETTINGS } from './settings.js';
import { USER_SECRETS } from './secrets.js';
import { summarizeCcBackends } from './llmEnv.js';
import { VARIANTS, API_IMAGES, CP_IMAGE, HINDSIGHT_VERSION } from './pins.js';
import { bundleName } from './jobs.js';
import { BACKFILL_LIMITS } from './backfill.js';
import { validateScopes, renderBank, templateProblem, SCOPE_ACTIONS, SESSION_KINDS, PLACEHOLDERS, SCOPE_LIMITS } from './scopes.js';

const AUTOSTART_CACHE_MS = 10_000;

const isJson = (req) => /^application\/json\b/i.test(String(req.headers['content-type'] ?? ''));

/**
 * @param {object} o
 * @param {ReturnType<import('./supervisor.js').createSupervisor>} o.supervisor
 * @param {ReturnType<import('./jobs.js').createJobs>} o.jobs
 * @param {ReturnType<import('./docker.js').createDocker>} o.docker
 * @param {ReturnType<import('./settings.js').createSettingsStore>} o.settings
 * @param {ReturnType<import('./secrets.js').createSecretsStore>} o.secrets
 * @param {() => Promise<unknown>} o.fetchCcModels
 * @param {ReturnType<import('./scopes.js').createScopesStore>} o.scopes
 * @param {ReturnType<import('./activity.js').createActivityLog>} o.activity
 * @param {ReturnType<import('./ccSession.js').createCcClient>} o.cc
 * @param {{latestScan(): object|null}} o.backfill
 * @param {() => Promise<{autoStart?: boolean} | null>} o.fetchPluginRow cc's row for this plugin
 * @param {() => string} o.detectBind
 * @param {{api: string, cp: string, relay: string}} o.containerNames
 * @param {{tags(): Promise<{model: string, cloud: boolean}[]>, version(): Promise<string|null>}} o.ollamaDaemon
 * @param {{probeDaemon(): Promise<{ok: boolean, version: string|null, error: string|null, at: string}>}} o.ollamaProxy
 */
export function createRoutes({ supervisor, jobs, docker, settings: settingsStore, secrets, fetchCcModels, fetchPluginRow, detectBind, containerNames, ollamaDaemon, ollamaProxy, scopes, activity, cc, backfill, now = () => Date.now() }) {
  let autoStart = { at: 0, value: undefined };

  async function readAutoStart() {
    if (now() - autoStart.at < AUTOSTART_CACHE_MS) return autoStart.value;
    let value;
    try { const row = await fetchPluginRow(); value = typeof row?.autoStart === 'boolean' ? row.autoStart : undefined; } catch { value = undefined; }
    autoStart = { at: now(), value };
    return value;
  }

  function settingsView() {
    return {
      settings: settingsStore.get(),
      secrets: secrets.has(),
      defaults: DEFAULT_SETTINGS,
      detectedBindAddress: detectBind(),
      choices: { variants: VARIANTS, llmModes: LLM_MODES, embeddingsProviders: EMBEDDINGS_PROVIDERS, rerankerProviders: RERANKER_PROVIDERS, slimRefused: SLIM_REFUSED, llmMaxConcurrentMax: LLM_MAX_CONCURRENT_MAX },
      images: { api: API_IMAGES, cp: CP_IMAGE, version: HINDSIGHT_VERSION },
    };
  }

  /** The link's status plus the daemon's answer and the problems to show (a down daemon, a relay the plugin cannot reach). */
  async function withDaemon(ollama) {
    const daemon = await ollamaProxy.probeDaemon();
    const problems = [];
    if (!daemon.ok) problems.push(describeError('OLLAMA_UNREACHABLE', { url: ollama.daemonUrl, detail: daemon.error }));
    if (ollama.tunnel.state === 'connecting') problems.push(describeError('RELAY_DISCONNECTED', { address: ollama.tunnel.address, detail: ollama.tunnel.error ?? 'connecting' }));
    return { ...ollama, daemon, problems };
  }

  /** The daemon's state and models for the picker (a failure is a state, not an error). */
  async function daemonView() {
    try {
      const [version, tags] = await Promise.all([ollamaDaemon.version(), ollamaDaemon.tags()]);
      return { reachable: true, version, error: null, tags };
    } catch (e) {
      return { reachable: false, version: null, error: e?.params?.detail ?? e?.message ?? String(e), tags: [] };
    }
  }

  async function status(refresh) {
    if (refresh) await supervisor.refresh();
    const s = supervisor.status();
    const a = await readAutoStart();
    if (s.ollama) s.ollama = await withDaemon(s.ollama);
    return { ...s, ...(a === undefined ? {} : { autoStart: a }), job: jobs.current(), bundles: jobs.bundles(), bundleNames: Object.fromEntries(VARIANTS.map((v) => [v, bundleName(v)])) };
  }

  /** Routes keyed `METHOD path`; a `:param` segment matches one path segment. */
  const table = [
    ['GET', '/-/api/health', () => ({ ok: true })],
    ['GET', '/-/api/status', (req, _res, _p, url) => status(url.searchParams.get('refresh') === '1')],
    ['GET', '/-/api/settings', () => settingsView()],
    ['PUT', '/-/api/settings', async (req) => {
      const body = await readJson(req);
      const patch = body.secrets && typeof body.secrets === 'object' ? body.secrets : {};
      for (const k of Object.keys(patch)) if (!USER_SECRETS.includes(k)) throw new AppError('BAD_REQUEST', { detail: `unknown secret "${k}"` });
      for (const [k, v] of Object.entries(patch)) if (v !== null && typeof v !== 'string') throw new AppError('BAD_REQUEST', { detail: `${k} must be a string or null` });
      const has = secrets.has();
      // A stored key is bound to where it is sent: repointing the provider or URL without
      // resending the key clears it, so a changed endpoint can never receive the old key.
      const before = keyEndpoints(settingsStore.get());
      const after = keyEndpoints(validateSettings(body.settings).settings);
      const effective = { ...patch };
      const cleared = [];
      for (const k of USER_SECRETS) {
        if (has[k] && before[k] !== after[k] && effective[k] === undefined) { effective[k] = null; cleared.push(k); }
      }
      const hasAfter = Object.fromEntries(USER_SECRETS.map((k) => [k, effective[k] === undefined ? has[k] : !!effective[k]]));
      const { settings, errors } = validateSettings(body.settings, hasAfter);
      if (errors.length) throw new AppError('SETTINGS_INVALID', { fields: errors });
      const sudoChanged = settings.docker.allowSudo !== settingsStore.get().docker.allowSudo;
      settingsStore.save(settings);
      if (Object.keys(effective).length) secrets.setUserSecrets(effective);
      if (sudoChanged) docker.reset();
      return { ...settingsView(), cleared, status: supervisor.status() };
    }],
    ['GET', '/-/api/scopes', () => ({
      scopes: scopes.get(),
      choices: { actions: SCOPE_ACTIONS, kinds: SESSION_KINDS, placeholders: PLACEHOLDERS, limits: SCOPE_LIMITS },
    })],
    ['PUT', '/-/api/scopes', async (req) => {
      const body = await readJson(req);
      const { scopes: valid, errors } = validateScopes(body.scopes);
      if (errors.length) throw new AppError('SCOPES_INVALID', { fields: errors });
      scopes.save(valid);
      return { scopes: valid };
    }],
    ['POST', '/-/api/memory/preview-bank', async (req) => {
      const { template, sample } = await readJson(req);
      const problem = templateProblem(template);
      if (problem) return { error: problem };
      const s = sample && typeof sample === 'object' ? sample : {};
      return renderBank(template, { project: String(s.project ?? 'example'), worktree: String(s.worktree ?? 'main'), kind: String(s.kind ?? 'worker') });
    }],
    ['GET', '/-/api/memory/activity', () => ({ entries: activity.list() })],
    ['GET', '/-/api/memory/backfill', () => ({ scan: backfill.latestScan() })],
    ['GET', '/-/api/memory/stages', async () => {
      try { return { stages: await cc.fetchStages(), error: null }; } catch (e) { return { stages: [], error: e?.message ?? String(e) }; }
    }],
    ['GET', '/-/api/memory/cc-projects', async () => {
      const [projects, workspaces] = await Promise.allSettled([cc.listProjects(), cc.listWorkspaces()]);
      const failed = [projects, workspaces].find((r) => r.status === 'rejected');
      return {
        projects: projects.status === 'fulfilled' ? projects.value : [],
        workspaces: workspaces.status === 'fulfilled' ? workspaces.value : [],
        error: failed ? (failed.reason?.message ?? String(failed.reason)) : null,
      };
    }],
    ['GET', '/-/api/cc-backends', async () => {
      const data = await fetchCcModels();
      const daemon = summarizeCcBackends(data).some((b) => b.kind === 'ollama') ? await daemonView() : null;
      return { backends: summarizeCcBackends(data, daemon) };
    }],
    ['POST', '/-/api/start', async () => { supervisor.ensureRunning(); return status(false); }],
    ['POST', '/-/api/restart', async () => { supervisor.restart(); return status(false); }],
    ['POST', '/-/api/stop', async () => { await supervisor.stop(); return status(true); }],
    ['GET', '/-/api/jobs', () => ({ jobs: jobs.list() })],
    ['GET', '/-/api/jobs/:id', (_req, _res, p) => {
      const j = jobs.get(p.id);
      if (!j) throw new AppError('NOT_FOUND', { detail: 'no such job' });
      return j;
    }],
    ['POST', '/-/api/jobs/:id/cancel', async (req, _res, p) => {
      await readJson(req);
      return jobs.cancel(p.id);
    }],
    ['POST', '/-/api/jobs/:kind', async (req, _res, p) => {
      if (p.kind === 'import' && /^application\/octet-stream\b/i.test(String(req.headers['content-type'] ?? ''))) {
        const { done } = jobs.start('import', { stdin: req });
        return done;
      }
      // A backfill selection names every chosen session; it may outgrow the default body limit.
      const { job } = jobs.start(p.kind, await readJson(req, p.kind === 'backfill-import' ? BACKFILL_LIMITS.selectionMaxBytes : undefined));
      return job;
    }],
    ['GET', '/-/api/logs/:role', async (_req, _res, p) => {
      if (!(p.role in containerNames)) throw new AppError('NOT_FOUND', { detail: 'role must be api, cp or relay' });
      await docker.resolve();
      return { role: p.role, log: await docker.logs(containerNames[p.role], 200) };
    }],
    ['GET', '/-/api/bundles/:name', (_req, res, p) => {
      const file = jobs.bundlePath(p.name);
      if (!file) throw new AppError('NOT_FOUND', { detail: 'no such bundle' });
      const st = fs.statSync(file);
      res.writeHead(200, { ...securityHeaders(), 'content-type': 'application/x-tar', 'content-length': st.size, 'content-disposition': `attachment; filename="${p.name}"`, 'cache-control': 'no-store' });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return undefined;
    }],
  ];

  function match(method, pathname) {
    const parts = pathname.split('/');
    let pathMatched = false;
    for (const [m, pattern, fn] of table) {
      const pp = pattern.split('/');
      if (pp.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(':')) { try { params[pp[i].slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; break; } if (!params[pp[i].slice(1)]) { ok = false; break; } } else if (pp[i] !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (m === method || (m === 'GET' && method === 'HEAD')) return { fn, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  /** Handle a /-/api/ request. */
  return async function handleApi(req, res, url) {
    const m = match(req.method, url.pathname);
    try {
      if (!m) throw new AppError('NOT_FOUND', { detail: `no route ${url.pathname}` });
      if (m.methodNotAllowed) return sendJson(res, 405, { ...describeError('BAD_REQUEST', { detail: `${req.method} not allowed` }) });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (isCrossSite(req)) throw new AppError('CROSS_SITE');
        const upload = url.pathname === '/-/api/jobs/import' && /^application\/octet-stream\b/i.test(String(req.headers['content-type'] ?? ''));
        if (!upload && !isJson(req)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { expected: 'application/json' });
      }
      const out = await m.fn(req, res, m.params, url);
      if (out !== undefined) sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof AppError) return sendJson(res, e.status, e.toJSON());
      if (e instanceof SyntaxError) return sendJson(res, 400, describeError('BAD_REQUEST', { detail: 'body is not valid JSON' }));
      if (e?.status === 413) return sendJson(res, 413, describeError('BAD_REQUEST', { detail: 'body too large' }));
      console.error('code-hindsight: route failed:', e);
      sendJson(res, 500, { ...describeError('BAD_REQUEST', { detail: 'internal error' }) });
    }
  };
}
