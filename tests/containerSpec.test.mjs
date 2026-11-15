// containerSpec.js: the two containers' run arguments, environment and labels, and the spec
// hash adoption compares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiSpec, cpSpec, relaySpec, embeddingsEnv, resourceNames, ownerId } from '../src/containerSpec.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { API_IMAGES, LABELS, RELAY_TARGETS } from '../src/pins.js';
import { defaultBindAddress, defaultGateway } from '../src/netDetect.js';

const names = resourceNames('code-hindsight');
const base = {
  names, image: { id: API_IMAGES.full.ids[0] }, variant: 'full', bind: '172.20.0.1', port: 18888,
  apiKey: 'k'.repeat(64), llmEnv: { HINDSIGHT_API_LLM_PROVIDER: 'none' }, embeddingsEnv: embeddingsEnv(DEFAULT_SETTINGS, {}), owner: 'o1',
};
const label = (args, key) => args[args.indexOf(`${key}=${args.find((a) => a.startsWith(`${key}=`))?.split('=')[1]}`)]?.split('=')[1];

test('resource names all carry the prefix', () => {
  assert.deepEqual(resourceNames('p'), { api: 'p-api', cp: 'p-cp', network: 'p-net', volume: 'p-data', build: 'p-build', relay: 'p-relay' });
  assert.equal(ownerId('/a'), ownerId('/a'));
  assert.notEqual(ownerId('/a'), ownerId('/b'));
});

// Spec 4/5/3: API on the private network, keyed, published on the bind address only, volume at .pg0, HF offline on full.
test('API spec: keyed, API-only, published on the bind address, data volume, HF offline on full', () => {
  const s = apiSpec(base);
  assert.equal(s.name, 'code-hindsight-api');
  assert.deepEqual(s.args.slice(0, 12), ['-d', '--name', 'code-hindsight-api', '--network', 'code-hindsight-net', '--network-alias', 'api', '--restart', 'on-failure:3', '-p', '172.20.0.1:18888:8888', '-v']);
  assert.equal(s.args[12], 'code-hindsight-data:/home/hindsight/.pg0');
  assert.equal(s.args.at(-1), API_IMAGES.full.ids[0], 'run by the verified image ID, not a tag');
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
  const s = apiSpec({ ...base, variant: 'slim', image: { id: API_IMAGES.slim.ids[0] }, embeddingsEnv: embeddingsEnv(settings, { embeddingsApiKey: 'ek' }) });
  assert.equal(s.env.HF_HUB_OFFLINE, undefined);
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER, 'openai');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, 'text-embedding-3-small');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL, 'https://e.example/v1');
  assert.equal(s.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY, 'ek');
  assert.equal(s.env.HINDSIGHT_API_RERANKER_PROVIDER, 'rrf');
});

// Spec 5/6: CP keyed, reaching the API over the private network by alias.
test('CP spec: own access key, API key, API by alias, published on the bind address', () => {
  const s = cpSpec({ names, image: { id: 'sha256:c' }, bind: '127.0.0.1', port: 19999, apiKey: 'a', accessKey: 'b', owner: 'o1' });
  assert.equal(s.name, 'code-hindsight-cp');
  assert.ok(s.args.includes('127.0.0.1:19999:9999'));
  assert.equal(s.args[s.args.indexOf('--network') + 1], 'code-hindsight-net');
  assert.deepEqual(s.env, { HINDSIGHT_CP_DATAPLANE_API_URL: 'http://api:8888', HINDSIGHT_CP_DATAPLANE_API_KEY: 'a', HINDSIGHT_CP_ACCESS_KEY: 'b' });
  assert.equal(s.args.at(-1), 'sha256:c');
});

// Spec 4: the API's shm holds pg0's vector-index DSM segment (bank creation).
test('API spec: /dev/shm is large enough for bank creation', () => {
  const OBSERVED_DSM_REQUEST = 533_795_360;
  const units = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  const parse = (v) => { const m = /^(\d+)([bkmg]?)$/i.exec(v); assert.ok(m, `unparseable --shm-size ${v}`); return Number(m[1]) * units[(m[2] || 'b').toLowerCase()]; };
  const { args } = apiSpec(base);
  const i = args.indexOf('--shm-size');
  assert.notEqual(i, -1, '--shm-size is set');
  assert.ok(parse(args[i + 1]) >= OBSERVED_DSM_REQUEST);
  assert.ok(i < args.indexOf('--label'), 'inside the hashed base args');
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
  // The spec hash this fixture yields without `--shm-size`.
  const NO_SHM_HASH = '8441e108850926f702b6f4cf';
  assert.notEqual(h, NO_SHM_HASH, 'an API container created without --shm-size is recreated');
});

// Spec 5: bind auto-detect — the gateway inside a container, loopback elsewhere.
test('bind auto-detect: default gateway in a container, else loopback', () => {
  const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\nmeth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\neth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n';
  assert.equal(defaultGateway(route), '172.20.0.1');
  assert.equal(defaultBindAddress({ dockerenvExists: true, procNetRoute: route }), '172.20.0.1');
  assert.equal(defaultBindAddress({ dockerenvExists: false, procNetRoute: route }), '127.0.0.1');
  assert.equal(defaultBindAddress({ dockerenvExists: true, procNetRoute: 'Iface\tDestination\n' }), '127.0.0.1');
});

// OL7: the relay container: prefixed, aliased `ollama`, only the tunnel port published, run by
// the verified API image ID, its key in env only, its hash following the script and the port.
test('OL7: relay spec is prefixed, read-only, publishes only the tunnel port and runs the verified image', () => {
  const o = { names, image: { id: API_IMAGES.full.ids[0] }, bind: '172.20.0.1', port: 18434, key: 'rk'.repeat(32), owner: 'o1', target: RELAY_TARGETS.ollama };
  const s = relaySpec(o);
  assert.equal(s.name, 'code-hindsight-relay');
  const arg = (flag) => s.args[s.args.indexOf(flag) + 1];
  assert.equal(arg('--network'), 'code-hindsight-net');
  assert.equal(arg('--network-alias'), 'ollama');
  assert.equal(arg('--entrypoint'), 'node');
  assert.deepEqual(s.args.filter((a, i) => s.args[i - 1] === '-p'), ['172.20.0.1:18434:7070'], 'the API-facing port is not published');
  for (const f of ['--read-only', '--cap-drop', '--security-opt']) assert.ok(s.args.includes(f), f);
  const image = s.args.indexOf(API_IMAGES.full.ids[0]);
  assert.ok(image > 0, 'run by the verified image ID');
  assert.deepEqual(s.args.slice(image + 1, image + 3), ['--input-type=module', '-e']);
  assert.match(s.args[image + 3], /HSR1/, 'the relay program is the script argument');
  assert.equal(s.args.join(' ').includes(o.key), false, 'the key is env only');
  assert.equal(s.env.RELAY_KEY, o.key);
  assert.equal(label(s.args, LABELS.role), 'relay');
  assert.equal(label(s.args, LABELS.spec), s.hash);
  assert.notEqual(relaySpec({ ...o, port: 18435 }).hash, s.hash);
  assert.notEqual(relaySpec({ ...o, image: { id: API_IMAGES.full.ids[1] } }).hash, s.hash);
  assert.equal(relaySpec(o).hash, s.hash, 'deterministic');
});

// LB9: the relay's alias and API port follow the target, the hash tells the targets apart, and no row token is in the spec.
test('LB9: relaySpec alias and RELAY_API_PORT follow the target; the spec hash differs between targets; the env has only the relay key', () => {
  const o = { names, image: { id: API_IMAGES.full.ids[0] }, bind: '172.20.0.1', port: 18434, key: 'rk'.repeat(32), owner: 'o1' };
  const ollama = relaySpec({ ...o, target: RELAY_TARGETS.ollama });
  const loop = relaySpec({ ...o, target: RELAY_TARGETS['anthropic-loopback'] });
  const arg = (s, flag) => s.args[s.args.indexOf(flag) + 1];
  assert.equal(arg(ollama, '--network-alias'), RELAY_TARGETS.ollama.alias);
  assert.equal(arg(loop, '--network-alias'), RELAY_TARGETS['anthropic-loopback'].alias);
  assert.equal(ollama.env.RELAY_API_PORT, String(RELAY_TARGETS.ollama.apiPort));
  assert.equal(loop.env.RELAY_API_PORT, String(RELAY_TARGETS['anthropic-loopback'].apiPort));
  assert.notEqual(ollama.hash, loop.hash);
  assert.deepEqual(Object.keys(loop.env).sort(), ['RELAY_API_PORT', 'RELAY_KEY', 'RELAY_MAX_WAITING', 'RELAY_TUNNEL_PORT']);
});
