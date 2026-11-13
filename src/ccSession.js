// What this plugin reads from cc: the live facts about a session (project, worktree, stage), and
// the stage names of cc's playbooks. Read-only; both go through documented cc routes.
import { AppError } from './errors.js';

export const DESCRIBE_TIMEOUT_MS = 1000;
export const STAGES_TTL_MS = 60_000;
const STAGES_TIMEOUT_MS = 5000;
/** The project a cc conductor session reports; `describe_session` has no separate kind field. */
export const CONDUCTOR_PROJECT = '.conduct';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isSessionId = (v) => typeof v === 'string' && SESSION_ID_RE.test(v);

/**
 * @param {{conductorUrl: string|null, fetchImpl?: typeof fetch, now?: () => number, describeTimeoutMs?: number}} o
 */
export function createCcClient({ conductorUrl, fetchImpl = fetch, now = () => Date.now(), describeTimeoutMs = DESCRIBE_TIMEOUT_MS }) {
  let stagesCache = { at: -Infinity, value: null };

  async function getJson(pathname, timeoutMs) {
    const res = await fetchImpl(new URL(pathname, conductorUrl), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${pathname} answered HTTP ${res.status}`);
    return res.json();
  }

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
        body = await res.json();
      } catch (e) {
        throw new AppError('SESSION_UNRESOLVED', { detail: e?.name === 'TimeoutError' ? 'cc did not answer in time' : (e?.message ?? String(e)) }, { cause: e });
      }
      if (body?.ok === false) {
        if (body.code === 'SESSION_UNKNOWN') throw new AppError('SESSION_NOT_LIVE', { sessionId });
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
  };
}
