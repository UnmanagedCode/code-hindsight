// A fake cc for the memory and backfill tests: `describe_session` answers programmable per call
// (live sessions, retired handles, transcript segments that name their handle, unlocatable ids),
// `/api/playbooks[/:id]` serves the given playbooks, and `list_projects` / `list_workspaces`
// serve programmable rows (or fail on demand). Every request is logged.
import http from 'node:http';

/**
 * @param {import('node:test').TestContext} t
 * @param {{playbooks?: Record<string, string[]>, projects?: {name: string, workspace: string|null, degraded?: string}[]}} [o] playbook id → stage names; list_projects rows
 */
export async function startFakeCc(t, { playbooks = { solo: ['plan', 'review'], relay: ['plan', 'implement', 'review', 'refine'] }, projects = [{ name: 'proj', workspace: 'WS' }] } = {}) {
  const calls = [];
  let projectRows = projects;
  let workspaceRows = [{ name: 'WS', projectCount: 1 }];
  /** null, an HTTP status, 'hang' (never answers) or 'bad-shape'. */
  let projectsFailure = null;
  /** null or an HTTP status for list_workspaces to answer. */
  let workspacesFailure = null;
  /** sessionId → answers, consumed in order (the last repeats). An answer is a `live` object, 'retired' or a raw body. */
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, url: req.url, body });
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url === '/mcp/tools/describe_session') {
      const queue = sessions.get(body.sessionId);
      if (!queue) return send(200, { ok: false, code: 'SESSION_UNKNOWN', sessionId: body.sessionId, reason: 'unknown' });
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      if (typeof answer === 'function') return answer(send);
      if (answer === 'retired') return send(200, { sessionId: body.sessionId, retired: { reason: 'pruned' } });
      if (answer.ok === false) return send(200, answer);
      return send(200, { sessionId: body.sessionId, live: answer });
    }
    if (req.url === '/mcp/tools/list_projects') {
      if (projectsFailure === 'hang') return undefined;
      if (projectsFailure === 'bad-shape') return send(200, { projects: [{ name: 'proj', workspace: 7 }] });
      if (projectsFailure) return send(projectsFailure, { ok: false, code: 'INTERNAL' });
      return send(200, { projects: projectRows.map((p) => ({ path: `/x/${p.name}`, liveCount: 0, ...p })) });
    }
    if (req.url === '/mcp/tools/list_workspaces') return workspacesFailure ? send(workspacesFailure, { ok: false, code: 'INTERNAL' }) : send(200, { workspaces: workspaceRows });
    if (req.url === '/api/playbooks') return send(200, { playbooks: Object.keys(playbooks).map((id) => ({ id })) });
    const m = /^\/api\/playbooks\/([^/]+)$/.exec(req.url);
    if (m && playbooks[m[1]]) return send(200, { id: m[1], stages: Object.fromEntries(playbooks[m[1]].map((s) => [s, {}])) });
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    describeCalls: () => calls.filter((c) => c.url === '/mcp/tools/describe_session').length,
    listProjectsCalls: () => calls.filter((c) => c.url === '/mcp/tools/list_projects').length,
    /** Replace the list_projects rows (a row may carry `degraded`). */
    setProjects(list) { projectRows = list; },
    setWorkspaces(list) { workspaceRows = list; },
    /** Make list_projects fail: an HTTP status, 'hang', 'bad-shape'; null to answer again. */
    failProjects(how) { projectsFailure = how; },
    /** Make list_workspaces answer this HTTP status; null to answer again. */
    failWorkspaces(status) { workspacesFailure = status; },
    /** Program a session: answers are consumed per call, the last repeats. */
    session(id, ...answers) { sessions.set(id, answers); },
    /** A transcript segment: describe_session on its backing id names the handle that owns it. */
    segment(backingId, handle) { sessions.set(backingId, [{ ok: false, code: 'SESSION_NOT_A_HANDLE', handle, reason: 'a backing segment id' }]); },
    /** A retired handle, as describe_session answers it (project and worktree at the top, the last stage under `retired`). */
    retired(handle, { project = 'proj', worktree = null, stage = 'implement', playbook = 'relay', title = null } = {}) {
      const row = { sessionId: handle, project, worktree, path: `/x/${project}`, retired: { playbook, stage, title, archived: false, lastActivity: '2026-01-01T00:00:00.000Z' } };
      sessions.set(handle, [(send) => send(200, row)]);
    },
    /** An id whose directory no registered project owns. */
    unlocatable(id) { sessions.set(id, [{ ok: false, code: 'SESSION_UNLOCATABLE', reason: 'no registered project owns its directory' }]); },
    /** describe_session calls naming `id`. */
    describedIds: () => calls.filter((c) => c.url === '/mcp/tools/describe_session').map((c) => c.body.sessionId),
  };
}

/** A `live` object as describe_session answers it. */
export const live = (over = {}) => ({ project: 'proj', worktree: { worktreeName: 'wt' }, playbook: 'relay', stage: 'implement', ...over });
