// ccSession.js: how cc's describe_session answer becomes the facts scopes match on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeCc, live } from './support/fakeCc.mjs';
import { createCcClient, WORKSPACES_TTL_MS } from '../src/ccSession.js';

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

/** A client on a fake clock: `clock.t` is the time `now()` reports. */
const clocked = async (t, o = {}) => {
  const cc = await startFakeCc(t);
  const clock = { t: 1_000_000 };
  return { cc, clock, ccClient: createCcClient({ conductorUrl: cc.url, now: () => clock.t, ...o }) };
};

test('workspaceOf serves from one list_projects read within the TTL, and a membership change is seen once it expires', async (t) => {
  const { cc, clock, ccClient } = await clocked(t);
  cc.setProjects([{ name: 'proj', workspace: null }, { name: 'other', workspace: 'HOME' }]);
  assert.equal(await ccClient.workspaceOf('proj'), null);
  assert.equal(await ccClient.workspaceOf('other'), 'HOME');
  cc.setProjects([{ name: 'proj', workspace: 'CC-Dev' }, { name: 'other', workspace: 'HOME' }]);
  clock.t += WORKSPACES_TTL_MS - 1;
  assert.equal(await ccClient.workspaceOf('proj'), null, 'still within the TTL');
  assert.equal(cc.listProjectsCalls(), 1);
  clock.t += 1;
  assert.equal(await ccClient.workspaceOf('proj'), 'CC-Dev', 'a project added to a workspace later matches it');
  assert.equal(cc.listProjectsCalls(), 2);
});

test('a project missing from a fresh index is read again once; still missing, degraded, or the conductor project are handled without guessing', async (t) => {
  const { cc, ccClient } = await clocked(t);
  assert.equal(await ccClient.workspaceOf('proj'), 'WS');
  cc.setProjects([{ name: 'proj', workspace: 'WS' }, { name: 'new', workspace: 'HOME' }, { name: 'broken', workspace: null, degraded: 'unparseable record' }]);
  assert.equal(await ccClient.workspaceOf('new'), 'HOME', 'registered after the index was read');
  assert.equal(cc.listProjectsCalls(), 2);
  await assert.rejects(ccClient.workspaceOf('ghost'), (e) => e.code === 'WORKSPACE_UNRESOLVED' && /ghost/.test(e.params.detail) && /does not include it/.test(e.params.detail));
  assert.equal(cc.listProjectsCalls(), 3, 'exactly one read for the missing project');
  await assert.rejects(ccClient.workspaceOf('broken'), (e) => e.code === 'WORKSPACE_UNRESOLVED' && /could not read its project record/.test(e.params.detail));
  const before = cc.listProjectsCalls();
  assert.equal(await ccClient.workspaceOf('.conduct'), null);
  assert.equal(cc.listProjectsCalls(), before, 'the conductor project is in no workspace, without asking cc');
});

test('workspaceOf fails WORKSPACE_UNRESOLVED on a 500, a hang, a bad shape and no cc; after the TTL a failed read never serves the old index', async (t) => {
  const { cc, clock, ccClient } = await clocked(t, { workspacesTimeoutMs: 50 });
  assert.equal(await ccClient.workspaceOf('proj'), 'WS');
  clock.t += WORKSPACES_TTL_MS;
  cc.failProjects(500);
  await assert.rejects(ccClient.workspaceOf('proj'), (e) => e.code === 'WORKSPACE_UNRESOLVED' && /HTTP 500/.test(e.params.detail));
  cc.failProjects('bad-shape');
  await assert.rejects(ccClient.workspaceOf('proj'), (e) => e.code === 'WORKSPACE_UNRESOLVED' && /unexpected shape/.test(e.params.detail));
  cc.failProjects('hang');
  await assert.rejects(ccClient.workspaceOf('proj'), (e) => e.code === 'WORKSPACE_UNRESOLVED' && /did not answer in time/.test(e.params.detail));
  await assert.rejects(createCcClient({ conductorUrl: null }).workspaceOf('proj'), { code: 'WORKSPACE_UNRESOLVED' });
});

test('concurrent lookups on a cold cache share one list_projects read', async (t) => {
  const { cc, ccClient } = await clocked(t);
  assert.deepEqual(await Promise.all([ccClient.workspaceOf('proj'), ccClient.workspaceOf('proj'), ccClient.workspaceOf('proj')]), ['WS', 'WS', 'WS']);
  assert.equal(cc.listProjectsCalls(), 1);
});

test('listWorkspaces answers cc\'s workspaces by name and throws on a bad answer; listProjects answers name and workspace', async (t) => {
  const { cc, ccClient } = await clocked(t);
  cc.setWorkspaces([{ name: 'TTD', projectCount: 3 }, { name: 'AI', projectCount: 0 }]);
  assert.deepEqual(await ccClient.listWorkspaces(), [{ name: 'AI', projectCount: 0 }, { name: 'TTD', projectCount: 3 }]);
  cc.setWorkspaces('nope');
  await assert.rejects(ccClient.listWorkspaces(), /unexpected shape/);
  cc.failWorkspaces(500);
  await assert.rejects(ccClient.listWorkspaces(), /HTTP 500/);
  cc.setProjects([{ name: 'b', workspace: null }, { name: 'a', workspace: 'AI' }]);
  assert.deepEqual(await ccClient.listProjects(), [{ name: 'a', workspace: 'AI' }, { name: 'b', workspace: null }]);
  await assert.rejects(createCcClient({ conductorUrl: null }).listWorkspaces());
});
