// The one retain item both live retain (memory.js) and the backfill importer (backfill.js) send:
// a JSONL rendering of turns, the session's context line and metadata. One rendering, so a turn
// reads the same in Hindsight whichever path retained it.

export const RETAIN_CONTEXT = "Conversation between a cc user (or a cc conductor) and a coding agent in a cc session. Record the agent's statements as claims it made, not as verified facts.";

/** One turn as a line of the item's content. */
export const renderTurn = (t) => JSON.stringify({ role: t.role, content: t.content, timestamp: t.timestamp ?? undefined });

/** The first turn timestamp that parses, or null. */
export function firstTimestamp(turns) {
  for (const t of turns) if (t.timestamp && !Number.isNaN(Date.parse(t.timestamp))) return t.timestamp;
  return null;
}

/**
 * @param {object} o
 * @param {string} o.sessionId the public cc session id (CC_SESSION_ID)
 * @param {string} o.documentId
 * @param {'append'|'replace'} o.updateMode
 * @param {{id: string, role: string, content: string, timestamp: string|null}[]} o.turns non-empty
 * @param {{project: string, worktree: string, kind: string, stage?: string|null}} o.session
 * @param {string} o.fallbackTimestamp dates the item when no turn timestamp parses
 * @param {string} [o.extraContext] appended to the context line
 * @param {Record<string, string>} [o.extraMetadata] Hindsight types metadata `dict[str, str]`: strings only
 */
export function buildRetainItem({ sessionId, documentId, updateMode, turns, session: ses, fallbackTimestamp, extraContext, extraMetadata }) {
  return {
    content: turns.map(renderTurn).join('\n'),
    document_id: documentId,
    update_mode: updateMode,
    timestamp: firstTimestamp(turns) ?? fallbackTimestamp,
    context: `${RETAIN_CONTEXT} Project ${ses.project}, worktree ${ses.worktree}, ${ses.kind} session${ses.stage ? `, stage ${ses.stage}` : ''}.${extraContext ? ` ${extraContext}` : ''}`,
    metadata: { source: 'code-hindsight', ccSessionId: sessionId, project: ses.project, worktree: ses.worktree, kind: ses.kind, ...(ses.stage ? { stage: ses.stage } : {}), ...(extraMetadata ?? {}) },
  };
}
