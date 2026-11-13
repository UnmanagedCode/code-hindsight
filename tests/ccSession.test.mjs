// ccSession.js: how cc's describe_session answer becomes the facts scopes match on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeCc, live } from './support/fakeCc.mjs';
import { createCcClient } from '../src/ccSession.js';

const client = async (t) => {
  const cc = await startFakeCc(t);
  return { cc, ccClient: createCcClient({ conductorUrl: cc.url }) };
};

test('a session in .conduct is a conductor and any other project a worker; a null worktree is main', async (t) => {
  const { cc, ccClient } = await client(t);
  cc.session('c', live({ project: '.conduct', worktree: null, stage: null, playbook: null }));
  cc.session('w', live({ project: 'proj', worktree: { worktreeName: 'feature-x' }, stage: 'review', playbook: 'solo' }));
  assert.deepEqual(await ccClient.resolveSession('c'), { sessionId: 'c', project: '.conduct', worktree: 'main', kind: 'conductor', stage: null, playbook: null });
  assert.deepEqual(await ccClient.resolveSession('w'), { sessionId: 'w', project: 'proj', worktree: 'feature-x', kind: 'worker', stage: 'review', playbook: 'solo' });
});

test('a non-2xx answer is SESSION_UNRESOLVED whatever its body says; SESSION_NOT_LIVE is only for the documented soft refusals and the retired arm', async (t) => {
  const { cc, ccClient } = await client(t);
  cc.session('boom', (send) => send(500, { ok: false, code: 'SESSION_UNKNOWN', reason: 'looks like a refusal' }));
  cc.session('bad', (send) => send(400, { ok: false, code: 'ARGS_INVALID' }));
  cc.session('retired', 'retired');
  cc.session('soft', { ok: false, code: 'SESSION_NOT_LIVE' });
  await assert.rejects(ccClient.resolveSession('boom'), { code: 'SESSION_UNRESOLVED' });
  await assert.rejects(ccClient.resolveSession('bad'), { code: 'SESSION_UNRESOLVED' });
  await assert.rejects(ccClient.resolveSession('retired'), { code: 'SESSION_NOT_LIVE' });
  await assert.rejects(ccClient.resolveSession('soft'), { code: 'SESSION_NOT_LIVE' });
  await assert.rejects(ccClient.resolveSession('never-heard-of'), { code: 'SESSION_NOT_LIVE' });
});

test('without a cc to ask the session is unresolved', async () => {
  await assert.rejects(createCcClient({ conductorUrl: null }).resolveSession('x'), { code: 'SESSION_UNRESOLVED' });
});
