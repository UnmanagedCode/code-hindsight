// The hook's budgets, shared by hook.mjs and the tests that pin their order
// (backend budget < these deadlines < the `timeout` of each hook in hooks.json).

/** Per-request deadlines in ms. */
export const HOOK_TIMEOUTS = Object.freeze({ recall: 62000, retain: 5000, reset: 1500 });
/** How long `retain` waits for the transcript to hold the final assistant message. */
export const TRANSCRIPT_WAIT_MS = 1000;
/** When the hook process force-exits, whatever hangs: its deadline plus the transcript wait and a margin. */
export const forceExitMs = (deadlineMs) => deadlineMs + TRANSCRIPT_WAIT_MS + 500;
/** Longest recall query the hook sends (chars of the user's prompt). */
export const RECALL_QUERY_MAX_CHARS = 2000;
/** Most transcript JSON the retain hook sends per Stop (the newest turns). */
export const RETAIN_TAIL_BYTES = 256 * 1024;
