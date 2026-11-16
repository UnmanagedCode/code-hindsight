// gpuCheck.js: reading the devices from the pinned upstream's start lines, and judging them
// against the settings' local models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelDevices, judgeDevices, assertOnCuda } from '../src/gpuCheck.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

// The lines as upstream logs them at UPSTREAM_TAG (hindsight-api-slim/hindsight_api/engine/
// embeddings.py and cross_encoder.py).
const START = [
  '2026-11-16 20:01:02,123 - INFO - hindsight_api.engine.embeddings - Embeddings: local provider initialized (dim: 384, device: cuda)',
  '2026-11-16 20:01:03,456 - INFO - hindsight_api.engine.cross_encoder - Reranker: local provider initialized (device: cuda, max_concurrent=4)',
].join('\n');
const settings = (patch = {}) => ({ ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...patch });

// GPU6: the devices come only from the models' own start lines.
test('GPU6: parses both start lines; the reranker line with a shared executor too', () => {
  assert.deepEqual(parseModelDevices(START), { embeddings: 'cuda', reranker: 'cuda' });
  assert.deepEqual(parseModelDevices('Reranker: local provider initialized (device: cpu, using existing executor)'), { embeddings: null, reranker: 'cpu' });
  assert.deepEqual(parseModelDevices('Embeddings: ONNX provider initialized (dim: 384, device: cuda)\nnoise'), { embeddings: null, reranker: null }, 'other providers do not count');
  assert.deepEqual(parseModelDevices(''), { embeddings: null, reranker: null });
});

test('GPU6: cuda on every local model passes; a cpu device or a missing line is GPU_NOT_USED', () => {
  assert.doesNotThrow(() => assertOnCuda({ embeddings: 'cuda', reranker: 'cuda' }, settings()));
  assert.throws(() => assertOnCuda({ embeddings: 'cuda', reranker: 'cpu' }, settings()), (e) => e.code === 'GPU_NOT_USED' && e.params.reranker === 'cpu' && e.params.embeddings === 'cuda');
  assert.throws(() => assertOnCuda({ embeddings: null, reranker: 'cuda' }, settings()), (e) => e.code === 'GPU_NOT_USED' && e.params.embeddings === null);
  assert.deepEqual(judgeDevices({ embeddings: null, reranker: 'cpu' }, settings()), { missing: ['embeddings'], notCuda: ['reranker'] });
});

test('GPU6: only local providers are checked', () => {
  const remoteEmb = settings({ embeddings: { provider: 'openai', model: 'm', baseUrl: null } });
  assert.doesNotThrow(() => assertOnCuda({ embeddings: null, reranker: 'cuda' }, remoteEmb));
  assert.throws(() => assertOnCuda({ embeddings: null, reranker: 'cpu' }, remoteEmb), (e) => e.code === 'GPU_NOT_USED' && !('embeddings' in e.params));
  assert.doesNotThrow(() => assertOnCuda({ embeddings: 'cuda', reranker: null }, settings({ reranker: { provider: 'rrf' } })));
});
