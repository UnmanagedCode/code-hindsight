// settings.js / secrets.js / fsPrivate.js: validation (including the slim rule), private file
// modes, and keys that are generated once and never exposed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateSettings, createSettingsStore, DEFAULT_SETTINGS, embeddingsFingerprint, containerSettingsHash } from '../src/settings.js';
import { createSecretsStore } from '../src/secrets.js';
import { mkRoot } from './helpers.mjs';

const withChanges = (patch) => {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const [k, v] of Object.entries(patch)) s[k] = typeof v === 'object' && v !== null ? { ...s[k], ...v } : v;
  return s;
};
const mode = (p) => fs.statSync(p).mode & 0o777;

// Spec 7: the LLM is unset by default (chunks-only); full image, local embeddings.
test('the defaults validate: full image, LLM none, local embeddings and reranker', () => {
  const { settings, errors } = validateSettings(DEFAULT_SETTINGS);
  assert.deepEqual(errors, []);
  assert.equal(settings.variant, 'full');
  assert.equal(settings.llm.mode, 'none');
  assert.equal(settings.network.bindAddress, null);
});

// Spec 2: slim is refused, by name, until remote embeddings and a non-local reranker are set.
test('slim with local embeddings and reranker is refused by name', () => {
  const { errors } = validateSettings(withChanges({ variant: 'slim' }));
  assert.deepEqual(errors.map((e) => e.code).sort(), ['SLIM_NEEDS_REMOTE_EMBEDDINGS', 'SLIM_NEEDS_RERANKER']);
});

// S4: remote embeddings without a key of their own would make Hindsight send the LLM key there.
test('remote embeddings without their own key are refused EMBEDDINGS_NEEDS_KEY (a base URL is not enough)', () => {
  const s = withChanges({ variant: 'slim', embeddings: { provider: 'openai', model: 'text-embedding-3-small' }, reranker: { provider: 'rrf' } });
  assert.deepEqual(validateSettings(s).errors.map((e) => [e.field, e.code]), [['embeddings.key', 'EMBEDDINGS_NEEDS_KEY']]);
  assert.deepEqual(validateSettings({ ...s, embeddings: { ...s.embeddings, baseUrl: 'http://tei.example:8080/v1' } }).errors.map((e) => e.code), ['EMBEDDINGS_NEEDS_KEY']);
  assert.deepEqual(validateSettings({ ...s, variant: 'full' }).errors.map((e) => e.code), ['EMBEDDINGS_NEEDS_KEY'], 'on the full image too');
  assert.deepEqual(validateSettings(s, { embeddingsApiKey: true }).errors, []);
});

// S7: the bind address must be one host address.
test('the bind address refuses unspecified, multicast, reserved and broadcast addresses', () => {
  for (const bad of ['0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
    assert.deepEqual(validateSettings(withChanges({ network: { bindAddress: bad } })).errors.map((e) => e.field), ['network.bindAddress'], bad);
  }
  for (const ok of ['127.0.0.1', '172.20.0.1', '10.0.0.5', '192.168.1.10']) assert.deepEqual(validateSettings(withChanges({ network: { bindAddress: ok } })).errors, [], ok);
});

test('field errors name the field: ports, bind address, manual and cc-backend LLM, unknown keys', () => {
  const fields = (s) => validateSettings(s).errors.map((e) => e.field);
  assert.deepEqual(fields(withChanges({ network: { apiPort: 80 } })), ['network.apiPort']);
  assert.deepEqual(fields(withChanges({ network: { cpPort: 18888 } })), ['network.cpPort']);
  assert.deepEqual(fields(withChanges({ network: { bindAddress: 'localhost' } })), ['network.bindAddress']);
  assert.deepEqual(fields(withChanges({ llm: { mode: 'manual' } })).sort(), ['llm.model', 'llm.provider']);
  assert.deepEqual(fields(withChanges({ llm: { mode: 'manual', provider: 'openai', model: 'gpt', baseUrl: 'ftp://x' } })), ['llm.baseUrl']);
  assert.deepEqual(fields(withChanges({ llm: { mode: 'cc-backend' } })).sort(), ['llm.backendId', 'llm.model']);
  assert.deepEqual(fields({ ...DEFAULT_SETTINGS, extra: 1 }), ['extra']);
  assert.deepEqual(fields(withChanges({ variant: 'huge' })), ['variant']);
  assert.deepEqual(fields(withChanges({ docker: { allowSudo: 'yes' } })), ['docker.allowSudo']);
});

test('the embeddings fingerprint follows provider and model; the container hash ignores docker.allowSudo', () => {
  assert.equal(embeddingsFingerprint(DEFAULT_SETTINGS), 'local');
  assert.equal(embeddingsFingerprint(withChanges({ embeddings: { provider: 'openai', model: 'm1' } })), 'openai:m1');
  assert.equal(containerSettingsHash(DEFAULT_SETTINGS), containerSettingsHash(withChanges({ docker: { allowSudo: false } })));
  assert.notEqual(containerSettingsHash(DEFAULT_SETTINGS), containerSettingsHash(withChanges({ network: { apiPort: 18889 } })));
});

// Spec 4: the data dir is 0700 and its files 0600.
test('settings.json and secrets.json are 0600 in a 0700 dir; settings never hold a secret', (t) => {
  const r = mkRoot(t);
  const store = createSettingsStore(r.dataDir);
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
  store.save(withChanges({ variant: 'slim' }));
  const secrets = createSecretsStore(r.dataDir);
  secrets.setUserSecrets({ llmApiKey: 'sk-llm' });
  assert.equal(mode(r.dataDir), 0o700);
  assert.equal(mode(store.file), 0o600);
  assert.equal(mode(secrets.file), 0o600);
  assert.equal(fs.readFileSync(store.file, 'utf8').includes('sk-llm'), false);
  assert.equal(createSettingsStore(r.dataDir).get().variant, 'slim');
  assert.deepEqual(fs.readdirSync(r.dataDir).filter((f) => f.endsWith('.tmp')), []);
});

test('generated keys are created once and stay stable; user keys are write-only', (t) => {
  const r = mkRoot(t);
  const a = createSecretsStore(r.dataDir).get();
  assert.match(a.apiKey, /^[0-9a-f]{64}$/);
  assert.match(a.cpAccessKey, /^[0-9a-f]{64}$/);
  assert.notEqual(a.apiKey, a.cpAccessKey);
  const again = createSecretsStore(r.dataDir);
  assert.equal(again.get().apiKey, a.apiKey);
  assert.deepEqual(again.has(), { llmApiKey: false, embeddingsApiKey: false });
  again.setUserSecrets({ llmApiKey: 'sk-1', embeddingsApiKey: 'sk-2' });
  assert.deepEqual(again.has(), { llmApiKey: true, embeddingsApiKey: true });
  again.setUserSecrets({ llmApiKey: null });
  assert.deepEqual(createSecretsStore(r.dataDir).has(), { llmApiKey: false, embeddingsApiKey: true });
  assert.equal(createSecretsStore(r.dataDir).get().apiKey, a.apiKey, 'clearing a user key keeps the generated ones');
  assert.equal(path.basename(again.file), 'secrets.json');
});

// OL3: the parallel-request cap is empty (Hindsight's default) or a whole number in range.
test('OL3: llm.maxConcurrent accepts null or 1..256 and refuses anything else by field', () => {
  const llm = (maxConcurrent) => withChanges({ llm: { maxConcurrent } });
  for (const ok of [null, 1, 32, 256]) assert.deepEqual(validateSettings(llm(ok)).errors, [], String(ok));
  for (const bad of [0, 257, -1, 1.5, '4', NaN]) {
    assert.deepEqual(validateSettings(llm(bad)).errors.map((e) => e.field), ['llm.maxConcurrent'], String(bad));
  }
});

// OL4: the relay port is a user port that differs from the API and control plane ports.
test('OL4: network.relayPort is 1024..65535 and distinct from apiPort and cpPort', () => {
  assert.equal(DEFAULT_SETTINGS.network.relayPort, 18434);
  const relay = (relayPort, extra = {}) => validateSettings(withChanges({ network: { relayPort, ...extra } })).errors.map((e) => e.field);
  assert.deepEqual(relay(20000), []);
  assert.deepEqual(relay(80), ['network.relayPort']);
  assert.deepEqual(relay(70000), ['network.relayPort']);
  assert.deepEqual(relay(18888), ['network.relayPort']);
  assert.deepEqual(relay(19999), ['network.relayPort']);
});

// OL5: both fields shape the containers, so changing one is a pending restart; the stored
// settings of an older install (no new fields) read as the defaults.
test('OL5: the new fields join the container hash, and a settings file without them reads as defaults', (t) => {
  const base = containerSettingsHash(DEFAULT_SETTINGS);
  assert.notEqual(containerSettingsHash(withChanges({ llm: { maxConcurrent: 4 } })), base);
  assert.notEqual(containerSettingsHash(withChanges({ network: { relayPort: 20000 } })), base);
  const r = mkRoot(t);
  fs.mkdirSync(r.dataDir, { recursive: true });
  fs.writeFileSync(path.join(r.dataDir, 'settings.json'), JSON.stringify({ network: { bindAddress: null, apiPort: 18888, cpPort: 19999 }, llm: { mode: 'none' } }));
  const got = createSettingsStore(r.dataDir).get();
  assert.equal(got.network.relayPort, 18434);
  assert.equal(got.llm.maxConcurrent, null);
});

// GPU1: compute is cpu by default and on an older settings file; gpu needs the full image and a
// local model; the mode shapes the containers (a change is a pending restart).
test('GPU1: compute defaults to cpu, takes cpu or gpu, and gpu needs the full image and a local model', (t) => {
  assert.equal(DEFAULT_SETTINGS.compute, 'cpu');
  assert.deepEqual(validateSettings(withChanges({ compute: 'gpu' })).errors, []);
  assert.deepEqual(validateSettings(withChanges({ compute: 'cpu' })).errors, []);
  assert.deepEqual(validateSettings(withChanges({ compute: 'cuda' })).errors.map((e) => e.field), ['compute']);
  const slim = validateSettings(withChanges({ compute: 'gpu', variant: 'slim', embeddings: { provider: 'openai', model: 'm' }, reranker: { provider: 'rrf' } }), { embeddingsApiKey: true });
  assert.deepEqual(slim.errors.map((e) => e.code), ['GPU_NEEDS_FULL']);
  const noLocal = validateSettings(withChanges({ compute: 'gpu', embeddings: { provider: 'openai', model: 'm' }, reranker: { provider: 'rrf' } }), { embeddingsApiKey: true });
  assert.deepEqual(noLocal.errors.map((e) => e.code), ['GPU_NEEDS_LOCAL_MODEL']);
  const oneLocal = validateSettings(withChanges({ compute: 'gpu', reranker: { provider: 'rrf' } }));
  assert.deepEqual(oneLocal.errors, [], 'local embeddings alone are enough');
  assert.notEqual(containerSettingsHash(withChanges({ compute: 'gpu' })), containerSettingsHash(DEFAULT_SETTINGS));
  const r = mkRoot(t);
  fs.mkdirSync(r.dataDir, { recursive: true });
  fs.writeFileSync(path.join(r.dataDir, 'settings.json'), JSON.stringify({ variant: 'full', llm: { mode: 'none' } }));
  assert.equal(createSettingsStore(r.dataDir).get().compute, 'cpu');
});
