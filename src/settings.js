// User settings (settings.json): which image, how docker is invoked, where ports are
// published, and how the API reaches an LLM and embeddings. Never holds a secret; keys live
// in secrets.json (secrets.js).
import path from 'node:path';
import crypto from 'node:crypto';
import { VARIANTS } from './pins.js';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const LLM_MODES = Object.freeze(['none', 'manual', 'cc-backend']);
export const EMBEDDINGS_PROVIDERS = Object.freeze(['local', 'openai']);
export const RERANKER_PROVIDERS = Object.freeze(['local', 'rrf']);
/** Providers the slim image cannot run: it ships no local models (measured: the API exits at start). */
export const SLIM_REFUSED = Object.freeze({ embeddings: Object.freeze(['local']), reranker: Object.freeze(['local']) });

export const DEFAULT_SETTINGS = Object.freeze({
  variant: 'full',
  docker: { allowSudo: true },
  network: { bindAddress: null, apiPort: 18888, cpPort: 19999 },
  llm: { mode: 'none', provider: null, model: null, baseUrl: null, backendId: null },
  embeddings: { provider: 'local', model: null, baseUrl: null },
  reranker: { provider: 'local' },
});

const SHAPE = {
  variant: null,
  docker: ['allowSudo'],
  network: ['bindAddress', 'apiPort', 'cpPort'],
  llm: ['mode', 'provider', 'model', 'baseUrl', 'backendId'],
  embeddings: ['provider', 'model', 'baseUrl'],
  reranker: ['provider'],
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const nonEmpty = (v, max = 200) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isHttpUrl = (v) => {
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
};

/**
 * Normalize and validate a full settings object.
 * @param {unknown} input
 * @param {{embeddingsApiKey?: boolean}} [has] which write-only secrets are set
 * @returns {{settings: object, errors: {field: string, code?: string, message: string}[]}}
 */
export function validateSettings(input, has = {}) {
  const errors = [];
  const err = (field, message, code) => errors.push(code ? { field, code, message } : { field, message });
  const settings = clone(DEFAULT_SETTINGS);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    err('settings', 'must be an object');
    return { settings, errors };
  }
  for (const [k, v] of Object.entries(input)) {
    if (!(k in SHAPE)) { err(k, 'unknown setting'); continue; }
    if (SHAPE[k] === null) { settings[k] = v; continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { err(k, 'must be an object'); continue; }
    for (const [kk, vv] of Object.entries(v)) {
      if (!SHAPE[k].includes(kk)) err(`${k}.${kk}`, 'unknown setting');
      else settings[k][kk] = vv;
    }
  }

  if (!VARIANTS.includes(settings.variant)) err('variant', `must be one of ${VARIANTS.join(', ')}`);
  if (typeof settings.docker.allowSudo !== 'boolean') err('docker.allowSudo', 'must be true or false');

  const n = settings.network;
  if (n.bindAddress !== null && !(typeof n.bindAddress === 'string' && IPV4.test(n.bindAddress))) err('network.bindAddress', 'must be an IPv4 address, or empty for automatic');
  for (const f of ['apiPort', 'cpPort']) {
    if (!Number.isInteger(n[f]) || n[f] < 1024 || n[f] > 65535) err(`network.${f}`, 'must be a port from 1024 to 65535');
  }
  if (n.apiPort === n.cpPort) err('network.cpPort', 'must differ from the API port');

  const l = settings.llm;
  if (!LLM_MODES.includes(l.mode)) err('llm.mode', `must be one of ${LLM_MODES.join(', ')}`);
  if (l.mode === 'manual') {
    if (!(typeof l.provider === 'string' && /^[a-z][a-z0-9_-]{0,40}$/.test(l.provider))) err('llm.provider', 'is required (a Hindsight provider name such as openai, anthropic or ollama)');
    if (!nonEmpty(l.model)) err('llm.model', 'is required');
    if (l.baseUrl !== null && !isHttpUrl(l.baseUrl)) err('llm.baseUrl', 'must be an http(s) URL, or empty');
  }
  if (l.mode === 'cc-backend') {
    if (!nonEmpty(l.backendId)) err('llm.backendId', 'is required');
    if (!nonEmpty(l.model)) err('llm.model', 'is required');
  }

  const e = settings.embeddings;
  if (!EMBEDDINGS_PROVIDERS.includes(e.provider)) err('embeddings.provider', `must be one of ${EMBEDDINGS_PROVIDERS.join(', ')}`);
  if (e.provider === 'openai' && !nonEmpty(e.model)) err('embeddings.model', 'is required');
  if (e.baseUrl !== null && !isHttpUrl(e.baseUrl)) err('embeddings.baseUrl', 'must be an http(s) URL, or empty');
  if (!RERANKER_PROVIDERS.includes(settings.reranker.provider)) err('reranker.provider', `must be one of ${RERANKER_PROVIDERS.join(', ')}`);

  if (settings.variant === 'slim') {
    const remoteReady = e.provider === 'openai' && (has.embeddingsApiKey || e.baseUrl);
    if (SLIM_REFUSED.embeddings.includes(e.provider) || (e.provider !== 'local' && !remoteReady)) {
      err('embeddings.provider', 'the slim image needs remote embeddings with a key or a base URL', 'SLIM_NEEDS_REMOTE_EMBEDDINGS');
    }
    if (SLIM_REFUSED.reranker.includes(settings.reranker.provider)) {
      err('reranker.provider', 'the slim image needs a reranker without a local model', 'SLIM_NEEDS_RERANKER');
    }
  }
  return { settings, errors };
}

/** What the stored memories' vectors depend on: switching it on an existing volume breaks recall. */
export function embeddingsFingerprint(settings) {
  const e = settings.embeddings;
  return e.provider === 'local' ? 'local' : `${e.provider}:${e.model}`;
}

/** A hash of everything that shapes the containers (settings minus how docker is invoked). */
export function containerSettingsHash(settings) {
  const { docker: _docker, ...rest } = settings;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

export function createSettingsStore(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  let current = null;
  return {
    file,
    /** The stored settings over the defaults (validation is the caller's: `validateSettings`). */
    get() {
      if (!current) {
        const stored = readJsonFile(file, {});
        const merged = clone(DEFAULT_SETTINGS);
        for (const k of Object.keys(SHAPE)) {
          if (!(k in stored)) continue;
          merged[k] = SHAPE[k] === null ? stored[k] : { ...merged[k], ...stored[k] };
        }
        current = merged;
      }
      return clone(current);
    },
    save(settings) {
      writePrivateFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
      current = clone(settings);
    },
  };
}
