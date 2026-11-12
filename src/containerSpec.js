// Pure builders for the two containers: `docker run` arguments, environment and labels, plus
// the spec hash an adopted container must match.
import crypto from 'node:crypto';
import { API_CONTAINER_PORT, API_DATA_PATH, CP_CONTAINER_PORT, LABELS } from './pins.js';

/** Every Docker resource this plugin creates, named from one prefix. */
export function resourceNames(prefix) {
  return { api: `${prefix}-api`, cp: `${prefix}-cp`, network: `${prefix}-net`, volume: `${prefix}-data`, build: `${prefix}-build` };
}

/** Identifies this cc's plugin instance on a shared Docker daemon. */
export function ownerId(dataDir) {
  return crypto.createHash('sha256').update(String(dataDir)).digest('hex').slice(0, 16);
}

/** The API's alias on the private network; the CP reaches the API by it. */
const API_ALIAS = 'api';

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
 * @param {{ref: string, id: string}} o.image
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
  ];
  const hash = specHash(image.id, [...base, image.ref], env);
  const labels = { [LABELS.managed]: '1', [LABELS.owner]: owner, [LABELS.role]: 'api', [LABELS.spec]: hash };
  return { name: names.api, args: [...base, ...labelArgs(labels), image.ref], env, hash };
}

/**
 * @param {object} o
 * @param {ReturnType<typeof resourceNames>} o.names
 * @param {{ref: string, id: string}} o.image
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
  const hash = specHash(image.id, [...base, image.ref], env);
  const labels = { [LABELS.managed]: '1', [LABELS.owner]: owner, [LABELS.role]: 'cp', [LABELS.spec]: hash };
  return { name: names.cp, args: [...base, ...labelArgs(labels), image.ref], env, hash };
}
