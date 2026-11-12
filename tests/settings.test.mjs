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

test('slim with remote embeddings but no key or base URL is still refused', () => {
  const s = withChanges({ variant: 'slim', embeddings: { provider: 'openai', model: 'text-embedding-3-small' }, reranker: { provider: 'rrf' } });
  assert.deepEqual(validateSettings(s).errors.map((e) => e.code), ['SLIM_NEEDS_REMOTE_EMBEDDINGS']);
  assert.deepEqual(validateSettings(s, { embeddingsApiKey: true }).errors, []);
  assert.deepEqual(validateSettings({ ...s, embeddings: { ...s.embeddings, baseUrl: 'http://tei.example:8080/v1' } }).errors, []);
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
