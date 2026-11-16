// Pure builders for the two containers: `docker run` arguments, environment and labels, plus
// the spec hash an adopted container must match.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { LLM_MAX_CONCURRENT_MAX } from './settings.js';
import { API_CONTAINER_PORT, API_DATA_PATH, CP_CONTAINER_PORT, LABELS, RELAY_TUNNEL_PORT } from './pins.js';

/** The relay program, run inside the API image; part of the relay's spec hash. */
const RELAY_SCRIPT = fs.readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');

/** Every Docker resource this plugin creates, named from one prefix. */
export function resourceNames(prefix) {
  return { api: `${prefix}-api`, cp: `${prefix}-cp`, network: `${prefix}-net`, volume: `${prefix}-data`, build: `${prefix}-build`, relay: `${prefix}-relay` };
}

/** Identifies this cc's plugin instance on a shared Docker daemon. */
export function ownerId(dataDir) {
  return crypto.createHash('sha256').update(String(dataDir)).digest('hex').slice(0, 16);
}

/** The API's alias on the private network; the CP reaches the API by it. */
const API_ALIAS = 'api';
// pg0 grows DSM segments in /dev/shm during vector-index builds; Docker's 64 MiB default fails bank creation.
const API_SHM_SIZE = '1g';

function specHash(imageId, args, env) {
  const sortedEnv = Object.keys(env).sort().map((k) => `${k}=${env[k]}`);
  return crypto.createHash('sha256').update(JSON.stringify([imageId, args, sortedEnv])).digest('hex').slice(0, 24);
}

function labelArgs(labels) {
  return Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
}

/** Embeddings and reranker env from settings (+ the embeddings key). */
export function embeddingsEnv(settings, secrets) {
  const e = settings.embeddings;
  const env = { HINDSIGHT_API_EMBEDDINGS_PROVIDER: e.provider, HINDSIGHT_API_RERANKER_PROVIDER: settings.reranker.provider };
  if (e.provider === 'openai') {
    env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL = e.model;
    if (e.baseUrl) env.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL = e.baseUrl;
    if (secrets.embeddingsApiKey) env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY = secrets.embeddingsApiKey;
  }
  return env;
}

/**
 * @param {object} o
 * @param {ReturnType<typeof resourceNames>} o.names
 * @param {{id: string}} o.image the image ID the pinned tag resolved to at start; containers run by it, so a re-pulled tag recreates them
 * @param {string} o.variant full | slim
 * @param {string} o.bind host address the port is published on
 * @param {number} o.port host port
 * @param {string} o.apiKey
 * @param {Record<string,string>} o.llmEnv from llmEnv.composeLlmEnv
 * @param {Record<string,string>} o.embeddingsEnv
 * @param {string} o.owner
 * @returns {{name: string, args: string[], env: Record<string,string>, hash: string}}
 */
export function apiSpec({ names, image, variant, bind, port, apiKey, llmEnv, embeddingsEnv: embEnv, owner }) {
  const env = {
    HINDSIGHT_ENABLE_CP: 'false',
    HINDSIGHT_API_TENANT_EXTENSION: 'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
    HINDSIGHT_API_TENANT_API_KEY: apiKey,
    // The full image carries its models; never let it reach for the Hugging Face hub.
    ...(variant === 'full' ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}),
    ...llmEnv,
    ...embEnv,
  };
  const base = [
    '-d', '--name', names.api,
    '--network', names.network, '--network-alias', API_ALIAS,
    '--restart', 'on-failure:3',
    '-p', `${bind}:${port}:${API_CONTAINER_PORT}`,
    '-v', `${names.volume}:${API_DATA_PATH}`,
    '--shm-size', API_SHM_SIZE,
  ];
  const hash = specHash(image.id, base, env);
  const labels = { [LABELS.managed]: '1', [LABELS.owner]: owner, [LABELS.role]: 'api', [LABELS.spec]: hash };
  return { name: names.api, args: [...base, ...labelArgs(labels), image.id], env, hash };
}

/**
 * @param {object} o
 * @param {ReturnType<typeof resourceNames>} o.names
 * @param {{id: string}} o.image the image ID the pinned tag resolved to at start; containers run by it, so a re-pulled tag recreates them
 * @param {string} o.bind
 * @param {number} o.port
 * @param {string} o.apiKey the API key the CP sends to the API
 * @param {string} o.accessKey the CP's own sign-in key
 * @param {string} o.owner
 */
export function cpSpec({ names, image, bind, port, apiKey, accessKey, owner }) {
  const env = {
    HINDSIGHT_CP_DATAPLANE_API_URL: `http://${API_ALIAS}:${API_CONTAINER_PORT}`,
    HINDSIGHT_CP_DATAPLANE_API_KEY: apiKey,
    HINDSIGHT_CP_ACCESS_KEY: accessKey,
  };
  const base = [
    '-d', '--name', names.cp,
    '--network', names.network,
    '--restart', 'on-failure:3',
    '-p', `${bind}:${port}:${CP_CONTAINER_PORT}`,
  ];
  const hash = specHash(image.id, base, env);
  const labels = { [LABELS.managed]: '1', [LABELS.owner]: owner, [LABELS.role]: 'cp', [LABELS.spec]: hash };
  return { name: names.cp, args: [...base, ...labelArgs(labels), image.id], env, hash };
}

/**
 * The relay: runs from the API image (which carries Node), reachable by the
 * API under the target's alias on the private network. Only the tunnel port is published; the
 * API-facing port is not.
 * @param {object} o
 * @param {ReturnType<typeof resourceNames>} o.names
 * @param {{id: string}} o.image the API image
 * @param {string} o.bind
 * @param {number} o.port host port the tunnel is published on
 * @param {string} o.key the relay key
 * @param {string} o.owner
 * @param {{alias: string, apiPort: number}} o.target an entry of RELAY_TARGETS
 */
export function relaySpec({ names, image, bind, port, key, owner, target }) {
  const env = { RELAY_KEY: key, RELAY_API_PORT: String(target.apiPort), RELAY_TUNNEL_PORT: String(RELAY_TUNNEL_PORT), RELAY_MAX_WAITING: String(LLM_MAX_CONCURRENT_MAX) };
  const base = [
    '-d', '--name', names.relay,
    '--network', names.network, '--network-alias', target.alias,
    '--restart', 'on-failure:3',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-p', `${bind}:${port}:${RELAY_TUNNEL_PORT}`,
    '--entrypoint', 'node',
  ];
  const command = ['--input-type=module', '-e', RELAY_SCRIPT];
  const hash = specHash(image.id, [...base, ...command], env);
  const labels = { [LABELS.managed]: '1', [LABELS.owner]: owner, [LABELS.role]: 'relay', [LABELS.spec]: hash };
  return { name: names.relay, args: [...base, ...labelArgs(labels), image.id, ...command], env, hash };
}
