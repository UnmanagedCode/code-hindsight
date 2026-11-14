// What this plugin reads from cc: the live facts about a session (project, worktree, stage), where a
// saved transcript file belongs (for the backfill importer), the stage names of cc's playbooks, and
// which cc workspace each project is in (plus the workspace list, for the scope editor). Read-only;
// all go through documented cc routes.
import { AppError } from './errors.js';

export const DESCRIBE_TIMEOUT_MS = 1000;
export const STAGES_TTL_MS = 60_000;
const STAGES_TIMEOUT_MS = 5000;
/** How long the project → workspace index serves before it is read again (the membership lag). */
export const WORKSPACES_TTL_MS = 30_000;
/** Deadline of the `list_projects` read on the hook path; with the other deadlines it must fit the hook's. */
export const WORKSPACES_TIMEOUT_MS = 900;
/** The project a cc conductor session reports; `describe_session` has no separate kind field. */
export const CONDUCTOR_PROJECT = '.conduct';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isSessionId = (v) => typeof v === 'string' && SESSION_ID_RE.test(v);

const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
/** cc's refusals that mean "cc has no place for this id": a settled answer, safe to remember. */
const PLACE_REFUSALS = new Set(['SESSION_UNLOCATABLE', 'SESSION_UNKNOWN']);

/**
 * @param {{conductorUrl: string|null, fetchImpl?: typeof fetch, now?: () => number, describeTimeoutMs?: number, workspacesTimeoutMs?: number}} o
 */
export function createCcClient({ conductorUrl, fetchImpl = fetch, now = () => Date.now(), describeTimeoutMs = DESCRIBE_TIMEOUT_MS, workspacesTimeoutMs = WORKSPACES_TIMEOUT_MS }) {
  let stagesCache = { at: -Infinity, value: null };
  /** name → {workspace, degraded}, as `list_projects` last answered. Never served past WORKSPACES_TTL_MS. */
  let projectsCache = { at: -Infinity, index: null };
  /** The match path's refresh in flight, shared by concurrent lookups. */
  let refreshing = null;

  async function getJson(pathname, timeoutMs) {
    const res = await fetchImpl(new URL(pathname, conductorUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${pathname} answered HTTP ${res.status}`);
    return res.json();
  }

  /** An MCP tool through cc's REST alias (`POST /mcp/tools/<name>` → the structured content). */
  async function callTool(name, timeoutMs) {
    const res = await fetchImpl(new URL(`/mcp/tools/${name}`, conductorUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}`);
    return res.json();
  }

  /** Read `list_projects` into the cache; returns the new index. Throws on any failure. */
  async function refreshProjects(timeoutMs) {
    const body = await callTool('list_projects', timeoutMs);
    const rows = body?.ok === false ? null : body?.projects;
    if (!Array.isArray(rows) || rows.some((p) => !isStr(p?.name) || !(isStr(p.workspace) || p.workspace === null))) {
      throw new Error('list_projects answered an unexpected shape');
    }
    const index = new Map(rows.map((p) => [p.name, { workspace: p.workspace, degraded: p.degraded != null && p.degraded !== false }]));
    projectsCache = { at: now(), index };
    return index;
  }

  /** describe_session's raw answer; throws when cc does not answer (network, deadline, HTTP, not JSON). */
  async function describe(sessionId, timeoutMs, signal) {
    const deadline = AbortSignal.timeout(timeoutMs);
    const res = await fetchImpl(new URL('/mcp/tools/describe_session', conductorUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!res.ok) throw new Error(`describe_session answered HTTP ${res.status}`);
    return res.json();
  }

  /** How a describe_session answer places a session (see `placeTranscript`). */
  function interpret(body, handle) {
    if (body?.ok === false) {
      return { outcome: 'unplaceable', handle, detail: `${body.code ?? 'error'}${body.reason ? `: ${body.reason}` : ''}`, cacheable: PLACE_REFUSALS.has(body.code) };
    }
    if (body?.live && typeof body.live === 'object') return { outcome: 'live', handle };
    const r = body?.retired;
    if (!r || typeof r !== 'object' || !nonEmpty(body.project)) {
      return { outcome: 'unplaceable', handle, detail: 'cc did not answer: describe_session carried no live or retired project', cacheable: false, ccError: true };
    }
    return {
      outcome: 'placed',
      handle,
      session: {
        sessionId: handle,
        project: body.project,
        worktree: nonEmpty(body.worktree) ? body.worktree : 'main',
        kind: body.project === CONDUCTOR_PROJECT ? 'conductor' : 'worker',
        stage: nonEmpty(r.stage) ? r.stage : null,
        playbook: nonEmpty(r.playbook) ? r.playbook : null,
      },
      title: nonEmpty(r.title) ? r.title : null,
    };
  }

  const freshIndex = () => (now() - projectsCache.at < WORKSPACES_TTL_MS ? projectsCache.index : null);

  return {
    /**
     * The session's current facts.
     * @throws {AppError} SESSION_UNRESOLVED (cc unreachable, slow or confused) or SESSION_NOT_LIVE
     */
    async resolveSession(sessionId) {
      if (!conductorUrl) throw new AppError('SESSION_UNRESOLVED', { detail: 'this backend has no cc to ask (CONDUCTOR_URL is unset)' });
      let body;
      try {
        const res = await fetchImpl(new URL('/mcp/tools/describe_session', conductorUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          signal: AbortSignal.timeout(describeTimeoutMs),
        });
        if (!res.ok) throw new Error(`describe_session answered HTTP ${res.status}`);
        body = await res.json();
      } catch (e) {
        throw new AppError('SESSION_UNRESOLVED', { detail: e?.name === 'TimeoutError' ? 'cc did not answer in time' : (e?.message ?? String(e)) }, { cause: e });
      }
      if (body?.ok === false) {
        if (body.code === 'SESSION_UNKNOWN' || body.code === 'SESSION_NOT_LIVE') throw new AppError('SESSION_NOT_LIVE', { sessionId });
        throw new AppError('SESSION_UNRESOLVED', { detail: `${body.code ?? 'error'}: ${body.reason ?? ''}` });
      }
      const live = body?.live;
      if (!live || typeof live !== 'object') throw new AppError('SESSION_NOT_LIVE', { sessionId });
      if (typeof live.project !== 'string' || !live.project) throw new AppError('SESSION_UNRESOLVED', { detail: 'describe_session carried no project' });
      return {
        sessionId,
        project: live.project,
        worktree: live.worktree?.worktreeName ?? 'main',
        kind: live.project === CONDUCTOR_PROJECT ? 'conductor' : 'worker',
        stage: typeof live.stage === 'string' && live.stage ? live.stage : null,
        playbook: typeof live.playbook === 'string' && live.playbook ? live.playbook : null,
      };
    },

    /** Whether this backend has a cc to ask (CONDUCTOR_URL is set). */
    isConfigured: () => !!conductorUrl,

    /**
     * Where a saved transcript belongs, from cc's record only (never the file's contents or its
     * directory name). The file name is a backing id: `describe_session` on it names the handle that
     * owns it (`SESSION_NOT_A_HANDLE.handle`) or answers that session's row; the handle is then
     * described once per `handles` memo. A retired session is placed with its last recorded stage.
     * - `{outcome: 'placed', handle, session, title}`
     * - `{outcome: 'live', handle}`: still running
     * - `{outcome: 'unplaceable', handle?, detail, cacheable, ccError?}`: `cacheable` only when cc
     *   answered that it has no place for it; `ccError` when cc did not answer at all.
     * Throws only when `signal` aborts.
     * @param {string} backingId
     * @param {{timeoutMs: number, signal?: AbortSignal, handles?: Map<string, Promise<object>>}} o
     */
    async placeTranscript(backingId, { timeoutMs, signal, handles = new Map() }) {
      const ask = async (id) => {
        try { return { body: await describe(id, timeoutMs, signal) }; } catch (e) {
          if (signal?.aborted) throw e;
          return { error: e?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : (e?.message ?? String(e)) };
        }
      };
      const noAnswer = (handle, error) => ({ outcome: 'unplaceable', ...(handle ? { handle } : {}), detail: `cc did not answer: ${error}`, cacheable: false, ccError: true });
      if (!conductorUrl) return noAnswer(null, 'CONDUCTOR_URL is unset');
      const first = await ask(backingId);
      if (first.error) return noAnswer(null, first.error);
      const body = first.body;
      if (body?.ok === false && body.code === 'SESSION_NOT_A_HANDLE') {
        if (!isSessionId(body.handle)) return noAnswer(null, 'SESSION_NOT_A_HANDLE named no handle');
        if (!handles.has(body.handle)) handles.set(body.handle, ask(body.handle));
        const second = await handles.get(body.handle);
        return second.error ? noAnswer(body.handle, second.error) : interpret(second.body, body.handle);
      }
      if (body?.ok === false) return interpret(body, undefined);
      const handle = isSessionId(body?.sessionId) ? body.sessionId : backingId;
      if (!handles.has(handle)) handles.set(handle, Promise.resolve(first));
      return interpret(body, handle);
    },

    /** Stage names across cc's playbooks: `[{name, playbooks: [id]}]`, cached for a minute. Throws when cc cannot be read. */
    async fetchStages() {
      if (!conductorUrl) throw new Error('CONDUCTOR_URL is unset');
      if (now() - stagesCache.at < STAGES_TTL_MS) return stagesCache.value;
      const list = await getJson('/api/playbooks', STAGES_TIMEOUT_MS);
      const ids = (list?.playbooks ?? []).map((p) => p?.id).filter((id) => typeof id === 'string');
      const byStage = new Map();
      await Promise.all(ids.map(async (id) => {
        const pb = await getJson(`/api/playbooks/${encodeURIComponent(id)}`, STAGES_TIMEOUT_MS);
        for (const name of Object.keys(pb?.stages ?? {})) {
          if (!byStage.has(name)) byStage.set(name, []);
          byStage.get(name).push(id);
        }
      }));
      const value = [...byStage].map(([name, playbooks]) => ({ name, playbooks: playbooks.sort() })).sort((a, b) => a.name.localeCompare(b.name));
      stagesCache = { at: now(), value };
      return value;
    },

    /**
     * The cc workspace a project is in (null: none; the conductor project is in none). Served from
     * an index at most WORKSPACES_TTL_MS old; a project missing from a cached index is read again
     * once. Never answers from an older index.
     * @throws {AppError} WORKSPACE_UNRESOLVED (cc unset, unreachable, slow or confused; the project unknown or unreadable to cc)
     */
    async workspaceOf(project) {
      if (project === CONDUCTOR_PROJECT) return null;
      const unresolved = (reason, cause) => new AppError('WORKSPACE_UNRESOLVED', { project, detail: `project ${project}: ${reason}` }, cause ? { cause } : undefined);
      if (!conductorUrl) throw unresolved('this backend has no cc to ask (CONDUCTOR_URL is unset)');
      let index = freshIndex();
      if (!index?.has(project)) {
        if (!refreshing) refreshing = refreshProjects(workspacesTimeoutMs).finally(() => { refreshing = null; });
        try { index = await refreshing; } catch (e) {
          throw unresolved(e?.name === 'TimeoutError' ? 'cc did not answer in time' : (e?.message ?? String(e)), e);
        }
      }
      const row = index.get(project);
      if (!row) throw unresolved("cc's project list does not include it");
      if (row.degraded) throw unresolved('cc could not read its project record');
      return row.workspace;
    },

    /** cc's projects for the scope editor: `[{name, workspace}]` by name. Throws when cc cannot be read. */
    async listProjects() {
      if (!conductorUrl) throw new Error('CONDUCTOR_URL is unset');
      const index = freshIndex() ?? await refreshProjects(STAGES_TIMEOUT_MS);
      return [...index].map(([name, { workspace }]) => ({ name, workspace })).sort((a, b) => a.name.localeCompare(b.name));
    },

    /** cc's workspaces for the scope editor: `[{name, projectCount}]` by name. Throws when cc cannot be read. */
    async listWorkspaces() {
      if (!conductorUrl) throw new Error('CONDUCTOR_URL is unset');
      const body = await callTool('list_workspaces', STAGES_TIMEOUT_MS);
      const rows = body?.ok === false ? null : body?.workspaces;
      if (!Array.isArray(rows) || rows.some((w) => !isStr(w?.name) || !Number.isInteger(w.projectCount))) {
        throw new Error('list_workspaces answered an unexpected shape');
      }
      return rows.map((w) => ({ name: w.name, projectCount: w.projectCount })).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
