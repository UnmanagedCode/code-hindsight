// containerSpec.js: the two containers' run arguments, environment and labels, and the spec
// hash adoption compares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiSpec, cpSpec, embeddingsEnv, resourceNames, ownerId } from '../src/containerSpec.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { API_IMAGES, CP_IMAGE, LABELS } from '../src/pins.js';
import { defaultBindAddress, defaultGateway } from '../src/netDetect.js';

const names = resourceNames('code-hindsight');
const base = {
  names, image: { ref: API_IMAGES.full.ref, id: 'sha256:a' }, variant: 'full', bind: '172.20.0.1', port: 18888,
  apiKey: 'k'.repeat(64), llmEnv: { HINDSIGHT_API_LLM_PROVIDER: 'none' }, embeddingsEnv: embeddingsEnv(DEFAULT_SETTINGS, {}), owner: 'o1',
};
const label = (args, key) => args[args.indexOf(`${key}=${args.find((a) => a.startsWith(`${key}=`))?.split('=')[1]}`)]?.split('=')[1];

test('resource names all carry the prefix', () => {
  assert.deepEqual(resourceNames('p'), { api: 'p-api', cp: 'p-cp', network: 'p-net', volume: 'p-data', build: 'p-build' });
  assert.equal(ownerId('/a'), ownerId('/a'));
  assert.notEqual(ownerId('/a'), ownerId('/b'));
});

// Spec 4/5/3: API on the private network, keyed, published on the bind address only, volume at .pg0, HF offline on full.
test('API spec: keyed, API-only, published on the bind address, data volume, HF offline on full', () => {
  const s = apiSpec(base);
  assert.equal(s.name, 'code-hindsight-api');
  assert.deepEqual(s.args.slice(0, 12), ['-d', '--name', 'code-hindsight-api', '--network', 'code-hindsight-net', '--network-alias', 'api', '--restart', 'on-failure:3', '-p', '172.20.0.1:18888:8888', '-v']);
  assert.equal(s.args[12], 'code-hindsight-data:/home/hindsight/.pg0');
  assert.equal(s.args.at(-1), API_IMAGES.full.ref);
  assert.equal(s.env.HINDSIGHT_ENABLE_CP, 'false');
  assert.equal(s.env.HINDSIGHT_API_TENANT_EXTENSION, 'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension');
  assert.equal(s.env.HINDSIGHT_API_TENANT_API_KEY, base.apiKey);
  assert.equal(s.env.HF_HUB_OFFLINE, '1');
  assert.equal(s.env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(s.env.HINDSIGHT_API_LLM_PROVIDER, 'none');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER, 'local');
  assert.equal(label(s.args, LABELS.owner), 'o1');
  assert.equal(label(s.args, LABELS.role), 'api');
  assert.equal(label(s.args, LABELS.spec), s.hash);
  assert.equal(s.args.join(' ').includes(base.apiKey), false, 'keys only in env');
  assert.equal(s.args.some((a) => a.includes(':9999')), false, 'the API image never publishes its CP port');
});

test('slim API spec carries remote embeddings and no HF offline flags', () => {
  const settings = { ...DEFAULT_SETTINGS, variant: 'slim', embeddings: { provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://e.example/v1' }, reranker: { provider: 'rrf' } };
  const s = apiSpec({ ...base, variant: 'slim', image: { ref: API_IMAGES.slim.ref, id: 'sha256:s' }, embeddingsEnv: embeddingsEnv(settings, { embeddingsApiKey: 'ek' }) });
  assert.equal(s.env.HF_HUB_OFFLINE, undefined);
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER, 'openai');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, 'text-embedding-3-small');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL, 'https://e.example/v1');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY, 'ek');
  assert.equal(s.env.HINDSIGHT_API_RERANKER_PROVIDER, 'rrf');
});

// Spec 5/6: CP keyed, reaching the API over the private network by alias.
test('CP spec: own access key, API key, API by alias, published on the bind address', () => {
  const s = cpSpec({ names, image: { ref: CP_IMAGE, id: 'sha256:c' }, bind: '127.0.0.1', port: 19999, apiKey: 'a', accessKey: 'b', owner: 'o1' });
  assert.equal(s.name, 'code-hindsight-cp');
  assert.ok(s.args.includes('127.0.0.1:19999:9999'));
  assert.equal(s.args[s.args.indexOf('--network') + 1], 'code-hindsight-net');
  assert.deepEqual(s.env, { HINDSIGHT_CP_DATAPLANE_API_URL: 'http://api:8888', HINDSIGHT_CP_DATAPLANE_API_KEY: 'a', HINDSIGHT_CP_ACCESS_KEY: 'b' });
  assert.equal(s.args.at(-1), CP_IMAGE);
});

// Decision 9: adoption requires the same spec hash; any change in image, args or env changes it.
test('the spec hash changes with the image, the env and the ports, and only with them', () => {
  const h = apiSpec(base).hash;
  assert.equal(apiSpec({ ...base }).hash, h);
  assert.notEqual(apiSpec({ ...base, image: { ...base.image, id: 'sha256:b' } }).hash, h);
  assert.notEqual(apiSpec({ ...base, apiKey: 'other' }).hash, h);
  assert.notEqual(apiSpec({ ...base, port: 18889 }).hash, h);
  assert.notEqual(apiSpec({ ...base, llmEnv: { HINDSIGHT_API_LLM_PROVIDER: 'openai' } }).hash, h);
  assert.equal(apiSpec({ ...base, owner: 'o2' }).hash, h, 'the owner label is not part of the spec');
});

// Spec 5: bind auto-detect — the gateway inside a container, loopback elsewhere.
test('bind auto-detect: default gateway in a container, else loopback', () => {
  const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\nmeth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\neth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n';
  assert.equal(defaultGateway(route), '172.20.0.1');
  assert.equal(defaultBindAddress({ dockerenvExists: true, procNetRoute: route }), '172.20.0.1');
  assert.equal(defaultBindAddress({ dockerenvExists: false, procNetRoute: route }), '127.0.0.1');
  assert.equal(defaultBindAddress({ dockerenvExists: true, procNetRoute: 'Iface\tDestination\n' }), '127.0.0.1');
});
