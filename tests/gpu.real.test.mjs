// Gated GPU compute against the real Docker daemon and GPU.
//
// GPU2-real (RUN_REAL_DOCKER=1 RUN_REAL_GPU_BUILD=1, needs network): the build-gpu job builds the
// GPU image in the build helper from upstream's recipe, labelled, with torch reporting CUDA.
// GPU11 (RUN_REAL_DOCKER=1; skipped unless the GPU image is present and the daemon can attach a
// GPU): a GPU stack is ready with both models on cuda, retains and recalls; a CPU restart on the
// same volume still recalls the memory, and so does GPU again; a second backend adopts the GPU API
// and re-reads its start lines from the real log.
//
// Every container, volume and network is a throwaway `code-hindsight-test-*`, removed in t.after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bootRealStack, hindsightApi, hostDocker, realSkipReason, REAL } from './support/realStack.mjs';
import { API_GPU_IMAGE, API_IMAGES, GPU_TORCH_FLAVOR, LABELS, UPSTREAM_REVISION } from '../src/pins.js';
import { RECALL_BUDGET, RECALL_MAX_TOKENS } from '../src/hindsightClient.js';
import { waitFor } from './helpers.mjs';

const tmpName = (what) => `code-hindsight-test-${what}-${crypto.randomBytes(3).toString('hex')}`;

/** Why the GPU build cannot run here, or false. */
function buildSkip() {
  if (!REAL) return 'set RUN_REAL_DOCKER=1 to run against the real Docker daemon';
  if (process.env.RUN_REAL_GPU_BUILD !== '1') return 'set RUN_REAL_GPU_BUILD=1 to build the GPU image (needs network and several GB)';
  if (hostDocker(['image', 'inspect', API_IMAGES.full.ref]).status !== 0) return `image ${API_IMAGES.full.ref} is not present locally (the build needs it; tests never pull)`;
  return false;
}

/** Why a GPU stack cannot run here, or false. */
function gpuSkip() {
  const base = realSkipReason('full');
  if (base) return base;
  if (hostDocker(['image', 'inspect', API_GPU_IMAGE]).status !== 0) return `image ${API_GPU_IMAGE} is not present (build it: RUN_REAL_GPU_BUILD=1)`;
  const name = tmpName('gpuprobe');
  const probe = hostDocker(['run', '--rm', '--name', name, '--network', 'none', '--gpus', 'all', '--entrypoint', 'nvidia-smi', API_GPU_IMAGE, '-L']);
  if (probe.status !== 0) return `the daemon cannot attach a GPU: ${probe.stderr.trim().slice(0, 300)}`;
  return false;
}

test('GPU2-real: build-gpu builds a labelled GPU image whose torch reports CUDA', { skip: buildSkip(), timeout: 90 * 60_000 }, async (t) => {
  const { app } = await bootRealStack(t);
  const end = await app.jobs.start('build-gpu').done;
  assert.equal(end.state, 'done', `${JSON.stringify(end.error)}\n${end.tail}`);
  assert.equal(end.result.image, API_GPU_IMAGE);
  const img = JSON.parse(hostDocker(['image', 'inspect', API_GPU_IMAGE]).stdout)[0];
  assert.equal(img.Config.Labels[LABELS.upstream], UPSTREAM_REVISION);
  assert.equal(img.Config.Labels[LABELS.cuda], GPU_TORCH_FLAVOR);
  const torch = hostDocker(['run', '--rm', '--name', tmpName('torch'), '--network', 'none', '--entrypoint', '/app/api/.venv/bin/python', API_GPU_IMAGE, '-c', 'import torch; print(torch.__version__, torch.version.cuda)']);
  assert.equal(torch.status, 0, torch.stderr);
  assert.match(torch.stdout, /\+cu129 12\.9/);
});

test('GPU11: a GPU stack loads both models on cuda, retains and recalls; memories survive CPU↔GPU switches on one volume', { skip: gpuSkip(), timeout: 40 * 60_000 }, async (t) => {
  const { app, again } = await bootRealStack(t, { settings: { compute: 'gpu' } });
  const sup = app.supervisor;
  const ready = async (mode) => {
    assert.equal(sup.status().state, 'ready', JSON.stringify(sup.status().error));
    assert.equal(sup.status().compute.mode, mode);
  };
  await sup.ensureRunning();
  await ready('gpu');
  assert.deepEqual(sup.status().compute.devices, { embeddings: 'cuda', reranker: 'cuda' });

  const bank = 'gpu-real';
  const marker = `GPU-MARKER-${crypto.randomBytes(4).toString('hex')}`;
  const retain = await hindsightApi(sup.connection(), 'POST', `/v1/default/banks/${bank}/memories`, {
    items: [{ content: `The ${marker} teapot is kept in the lighthouse attic.`, document_id: 'gpu-doc', update_mode: 'replace' }],
    async: false,
  });
  assert.ok(retain.status >= 200 && retain.status < 300, retain.text);
  const recalls = async () => {
    const r = await hindsightApi(sup.connection(), 'POST', `/v1/default/banks/${bank}/memories/recall`, { query: 'Where is the teapot kept?', budget: RECALL_BUDGET, max_tokens: RECALL_MAX_TOKENS });
    return r.status === 200 && JSON.stringify(r.json?.results ?? []).includes(marker);
  };
  await waitFor(recalls, { timeoutMs: 120_000, stepMs: 1_000 });

  const switchTo = async (mode) => {
    const s = app.settings.get();
    s.compute = mode;
    app.settings.save(s);
    assert.equal(sup.status().pendingRestart, true);
    await sup.restart();
    await ready(mode);
  };
  await switchTo('cpu');
  assert.equal(sup.status().compute.devices, null);
  assert.equal(await recalls(), true, 'recall on CPU finds what GPU stored');
  await switchTo('gpu');
  assert.deepEqual(sup.status().compute.devices, { embeddings: 'cuda', reranker: 'cuda' });
  assert.equal(await recalls(), true, 'recall on GPU again');

  // A second backend adopts the running GPU API and reads its start lines from the real log window.
  const second = await again();
  await second.app.supervisor.ensureRunning();
  assert.equal(second.app.supervisor.status().state, 'ready', JSON.stringify(second.app.supervisor.status().error));
  assert.deepEqual(second.app.supervisor.status().compute.devices, { embeddings: 'cuda', reranker: 'cuda' });
});
