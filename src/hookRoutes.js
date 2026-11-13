// The non-browser routes: `/-/hook/{recall,retain,reset}` (Claude Code hooks, through cc's proxy)
// and `/-/mcp` (cc's plugin MCP forwarding). They carry other sessions' memories and accept
// transcript content, so a request that looks like a browser's is refused: a web page, including
// script on cc's own origin, can neither read memories nor inject retains through them.
import { AppError, describeError } from './errors.js';
import { sendJson, readJson } from './http.js';
import { isSessionId } from './ccSession.js';

export const HOOK_BODY_LIMITS = Object.freeze({ retain: 512 * 1024, other: 16 * 1024 });
export const MCP_QUERY_MAX_CHARS = 2000;
export const TURN_ROLES = Object.freeze(['user', 'assistant', 'action']);
const MAX_TURNS = 5000;

/** Headers only a browser adds. Node's fetch sends `Sec-Fetch-Mode` alone, which is not one of them. */
const BROWSER_HEADERS = ['origin', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user'];

const bad = (detail) => new AppError('BAD_REQUEST', { detail });

function validTurns(turns) {
  return Array.isArray(turns) && turns.length <= MAX_TURNS && turns.every((t) => t && typeof t === 'object'
    && typeof t.id === 'string' && TURN_ROLES.includes(t.role) && typeof t.content === 'string'
    && (t.timestamp === null || typeof t.timestamp === 'string'));
}

/** @param {{memory: ReturnType<import('./memory.js').createMemory>}} o */
export function createHookRoutes({ memory }) {
  async function hook(event, req, res) {
    const body = await readJson(req, event === 'retain' ? HOOK_BODY_LIMITS.retain : HOOK_BODY_LIMITS.other);
    if (!isSessionId(body.sessionId)) throw bad('sessionId must be a cc session id');
    if (event === 'recall') {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw bad('prompt must be a non-empty string');
      return sendJson(res, 200, await memory.recallForHook(body.sessionId, body.prompt));
    }
    if (event === 'retain') {
      if (!validTurns(body.turns)) throw bad('turns must be a list of {id, role, content, timestamp}');
      return sendJson(res, 202, await memory.retainForHook(body.sessionId, body.turns));
    }
    memory.resetContext(body.sessionId);
    return sendJson(res, 200, { ok: true });
  }

  /** cc's plugin-MCP contract: always 200, `{text}` or `{error, code}`. */
  async function mcp(req, res) {
    const body = await readJson(req, HOOK_BODY_LIMITS.other);
    if (body.tool !== 'recall') return sendJson(res, 200, { error: `unknown tool ${JSON.stringify(String(body.tool))}` });
    const query = body.arguments?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > MCP_QUERY_MAX_CHARS) {
      return sendJson(res, 200, { error: `query must be a string of 1–${MCP_QUERY_MAX_CHARS} characters`, code: 'BAD_REQUEST' });
    }
    const sessionId = body.caller?.sessionId;
    if (sessionId !== undefined && sessionId !== null && !isSessionId(sessionId)) return sendJson(res, 200, { error: 'caller.sessionId is not a session id', code: 'BAD_REQUEST' });
    try {
      return sendJson(res, 200, { text: await memory.recallForMcp(sessionId ?? null, query) });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return sendJson(res, 200, { error: e.message, code: e.code });
    }
  }

  /** Handle `/-/hook/*` and `/-/mcp`. */
  return async function handleHook(req, res, url) {
    try {
      const isMcp = url.pathname === '/-/mcp';
      const event = url.pathname.startsWith('/-/hook/') ? url.pathname.slice('/-/hook/'.length) : null;
      if (!isMcp && !['recall', 'retain', 'reset'].includes(event)) throw new AppError('NOT_FOUND', { detail: `no route ${url.pathname}` });
      if (req.method !== 'POST') return sendJson(res, 405, describeError('BAD_REQUEST', { detail: `${req.method} not allowed` }));
      if (BROWSER_HEADERS.some((h) => req.headers[h] !== undefined) || (isMcp && req.headers['x-forwarded-prefix'] !== undefined)) throw new AppError('BROWSER_REFUSED');
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { expected: 'application/json' });
      return await (isMcp ? mcp(req, res) : hook(event, req, res));
    } catch (e) {
      if (e instanceof AppError) return sendJson(res, e.status, e.toJSON());
      if (e instanceof SyntaxError) return sendJson(res, 400, describeError('BAD_REQUEST', { detail: 'body is not valid JSON' }));
      if (e?.status === 413) return sendJson(res, 413, describeError('BAD_REQUEST', { detail: 'body too large' }));
      console.error('code-hindsight: hook route failed:', e);
      return sendJson(res, 500, describeError('BAD_REQUEST', { detail: 'internal error' }));
    }
  };
}
