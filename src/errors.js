// The error catalog: every named error the backend reports, with the text and the one action
// the UI offers for it. The UI renders these entries; it holds no copy of its own.

/** Actions the UI can offer for an error (the Status page maps each to a button). */
export const ACTIONS = Object.freeze({
  pull: 'pull',
  build: 'build-cp',
  buildGpu: 'build-gpu',
  import: 'import',
  start: 'start',
  restart: 'restart',
  settings: 'settings',
  stop: 'stop',
});

const s = (v) => (v === undefined || v === null ? '' : String(v));

/** code → { title, message(params), action, status (HTTP status when it refuses a request) } */
export const CATALOG = Object.freeze({
  DOCKER_NOT_FOUND: {
    title: 'Docker is not installed',
    message: (p) => `The docker CLI could not be run${p.bin ? ` (${s(p.bin)})` : ''}. Install Docker in the environment cc runs in, or point CODE_HINDSIGHT_DOCKER_BIN at it.`,
    action: null, status: 503,
  },
  DOCKER_DENIED: {
    title: 'No permission to use Docker',
    message: (p) => (p.sudoAllowed
      ? `docker was refused and \`sudo -n docker\` failed too: ${s(p.detail)}`
      : `docker was refused (${s(p.detail)}). Allow \`sudo -n docker\` in Settings, or give cc's user access to the Docker socket.`),
    action: ACTIONS.settings, status: 503,
  },
  DOCKER_DAEMON_DOWN: {
    title: 'The Docker daemon is not reachable',
    message: (p) => `docker could not reach its daemon: ${s(p.detail)}`,
    action: ACTIONS.start, status: 503,
  },
  DOCKER_FAILED: {
    title: 'A docker command failed',
    message: (p) => `\`docker ${s(p.command)}\` failed: ${s(p.detail)}`,
    action: ACTIONS.start, status: 502,
  },
  IMAGE_MISSING: {
    title: 'The Hindsight image is not on this machine',
    message: (p) => `${s(p.image)} is missing. Pull it, or import an offline bundle on Images & data. Nothing is pulled automatically.`,
    action: ACTIONS.pull, status: 409,
  },
  CP_IMAGE_MISSING: {
    title: 'The control-plane image has not been built',
    message: (p) => `${s(p.image)} is missing. Build it once (needs network), or import a bundle that contains it.`,
    action: ACTIONS.build, status: 409,
  },
  CP_IMAGE_MISMATCH: {
    title: 'The control-plane image was built for something else',
    message: (p) => `${s(p.image)} carries ${s(p.found)}; this plugin needs ${s(p.expected)}. Build it again once (Images & data → Build CP image; needs network).`,
    action: ACTIONS.build, status: 409,
  },
  GPU_IMAGE_MISSING: {
    title: 'The GPU image has not been built',
    message: (p) => `Compute is set to GPU, and ${s(p.image)} is missing. Build it once on Images & data (needs network and several GB of disk), or set Compute to CPU in Settings.`,
    action: ACTIONS.buildGpu, status: 409,
  },
  GPU_IMAGE_MISMATCH: {
    title: 'The GPU image was built for something else',
    message: (p) => `${s(p.image)} carries ${s(p.found)}; this plugin needs ${s(p.expected)}. Build it again.`,
    action: ACTIONS.buildGpu, status: 409,
  },
  GPU_UNAVAILABLE: {
    title: 'Docker cannot give the API a GPU',
    message: (p) => `Compute is set to GPU, but the Docker daemon could not attach one: ${s(p.detail)}\nOn the Docker host: install the NVIDIA driver and the NVIDIA Container Toolkit (https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), run \`sudo nvidia-ctk runtime configure --runtime=docker\`, restart dockerd, and check with \`docker run --rm --gpus all <any image> nvidia-smi\`. Or set Compute to CPU in Settings.`,
    action: ACTIONS.settings, status: 503,
  },
  GPU_NOT_USED: {
    title: 'The models did not load on the GPU',
    message: (p) => `Compute is set to GPU, but the API's local models loaded on: ${['embeddings', 'reranker'].filter((m) => m in p).map((m) => `${m} ${s(p[m] ?? 'unknown (no start line in its log)')}`).join(', ')}. The API container was stopped rather than left running on the CPU. Check the GPU on the host (\`nvidia-smi\`), rebuild the GPU image, or set Compute to CPU in Settings.`,
    action: ACTIONS.settings, status: 502,
  },
  GPU_NEEDS_FULL: {
    title: 'GPU compute needs the full image',
    message: () => 'Only the full image runs local models, which are what the GPU speeds up. Choose the full image, or set Compute to CPU.',
    action: ACTIONS.settings, status: 400,
  },
  GPU_NEEDS_LOCAL_MODEL: {
    title: 'GPU compute needs a local model',
    message: () => 'With remote embeddings and a non-local reranker nothing runs on the GPU. Use local embeddings or the local reranker, or set Compute to CPU.',
    action: ACTIONS.settings, status: 400,
  },
  NAME_TAKEN: {
    title: 'A Docker resource with this plugin\'s name belongs to someone else',
    message: (p) => `${s(p.kind)} ${s(p.name)} exists but was not created by this cc. It is left untouched; remove or rename it yourself.`,
    action: null, status: 409,
  },
  EMBEDDINGS_CHANGED: {
    title: 'The embeddings no longer match the stored memories',
    message: (p) => `Volume ${s(p.volume)} holds memories embedded with ${s(p.current)}; the settings ask for ${s(p.wanted)}. Revert the embeddings settings, or delete the data volume on Images & data.`,
    action: ACTIONS.settings, status: 409,
  },
  PORT_IN_USE: {
    title: 'A host port is already taken',
    message: (p) => `Port ${s(p.port)} on ${s(p.address)} is in use. Change ${s(p.setting)} in Settings.`,
    action: ACTIONS.settings, status: 409,
  },
  UNHEALTHY: {
    title: 'Hindsight did not become healthy',
    message: (p) => `The ${s(p.role)} container is running but ${s(p.url)} did not answer in time.${p.tail ? `\n${s(p.tail)}` : ''}`,
    action: ACTIONS.restart, status: 503,
  },
  CRASHED: {
    title: 'A Hindsight container stopped',
    message: (p) => `The ${s(p.role)} container exited with code ${s(p.exitCode)}.${p.tail ? `\n${s(p.tail)}` : ''}`,
    action: ACTIONS.restart, status: 503,
  },
  CP_LOGIN_FAILED: {
    title: 'Could not sign in to the control plane',
    message: (p) => `The control plane refused the access key (${s(p.detail)}). Restart Hindsight to recreate it.`,
    action: ACTIONS.restart, status: 502,
  },
  CC_UNREACHABLE: {
    title: 'cc could not be reached',
    message: (p) => `Reading the cc backend list failed: ${s(p.detail)}`,
    action: ACTIONS.settings, status: 502,
  },
  CC_ROUTE_CHANGED: {
    title: 'cc\'s backend list has an unexpected shape',
    message: (p) => `GET /api/settings/models answered in a shape this plugin does not know (${s(p.detail)}). Set the LLM manually.`,
    action: ACTIONS.settings, status: 502,
  },
  CC_BACKEND_MISSING: {
    title: 'The linked cc backend is gone',
    message: (p) => `cc has no backend "${s(p.backendId)}" any more. Pick another one, or set the LLM manually.`,
    action: ACTIONS.settings, status: 409,
  },
  CC_BACKEND_UNSUPPORTED: {
    title: 'The linked cc backend cannot be used',
    message: (p) => `cc backend "${s(p.backendId)}" has no ANTHROPIC_BASE_URL with ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, and does not launch \`ollama\`. Pick another one, or set the LLM manually.`,
    action: ACTIONS.settings, status: 409,
  },
  CC_BACKEND_LOOPBACK: {
    title: 'The linked cc backend uses TLS on loopback',
    message: (p) => `cc backend "${s(p.backendId)}" talks https to ${s(p.host)}, cc's own loopback. The relay forwards plain HTTP only, so it cannot be linked. Pick another one, or set the LLM manually.`,
    action: ACTIONS.settings, status: 409,
  },
  CC_BACKEND_UNREACHABLE: {
    title: 'The linked cc backend did not answer',
    message: (p) => `The linked cc backend's endpoint at ${s(p.url)} did not answer (${s(p.detail)}). It runs in cc's container: start it there.`,
    status: 502,
  },
  OLLAMA_UNREACHABLE: {
    title: 'The Ollama daemon did not answer',
    message: (p) => `Ollama at ${s(p.url)} did not answer (${s(p.detail)}). It runs in cc's container: start \`ollama serve\` there.`,
    status: 502,
  },
  RELAY_DISCONNECTED: {
    title: 'The relay is not connected',
    message: (p) => `The plugin cannot reach the relay at ${s(p.address)} (${s(p.detail)}).`,
    action: ACTIONS.restart, status: 502,
  },
  SLIM_NEEDS_REMOTE_EMBEDDINGS: {
    title: 'The slim image needs remote embeddings',
    message: () => 'The slim image ships no local embedding model. Set a remote embeddings provider with its key, or use the full image.',
    action: ACTIONS.settings, status: 400,
  },
  SLIM_NEEDS_RERANKER: {
    title: 'The slim image needs a non-local reranker',
    message: () => 'The slim image ships no local reranker model. Choose a reranker that needs no local model, or use the full image.',
    action: ACTIONS.settings, status: 400,
  },
  EMBEDDINGS_NEEDS_KEY: {
    title: 'Remote embeddings need their own key',
    message: () => 'Set an embeddings API key. Hindsight would otherwise send the LLM key to the embeddings endpoint.',
    action: ACTIONS.settings, status: 400,
  },
  SETTINGS_INVALID: {
    title: 'The settings are not valid',
    message: (p) => (Array.isArray(p.fields) ? p.fields.map((f) => `${f.field}: ${f.message}`).join('; ') : 'invalid settings'),
    action: ACTIONS.settings, status: 400,
  },
  SCOPES_INVALID: {
    title: 'The memory scopes are not valid',
    message: (p) => (Array.isArray(p.fields) ? p.fields.map((f) => `${f.field}: ${f.message}`).join('; ') : 'invalid scopes'),
    action: null, status: 400,
  },
  BROWSER_REFUSED: {
    title: 'Browser request refused',
    message: () => 'The hook and memory-tool routes answer only non-browser callers (no Origin or Sec-Fetch-Site/-Dest/-User headers, no proxy prefix on the tool route).',
    action: null, status: 403,
  },
  NO_SESSION: { title: 'No calling session', message: () => 'The memory tool needs to know which cc session is calling; anonymous callers get nothing.', action: null, status: 403 },
  SESSION_UNRESOLVED: {
    title: 'The session could not be resolved',
    message: (p) => `cc did not say which project and stage this session is in (${s(p.detail)}); it is treated as memoryless.`,
    action: null, status: 502,
  },
  SESSION_NOT_LIVE: {
    title: 'The session is not live',
    message: (p) => `cc has no live session ${s(p.sessionId)}; memory is only served to live sessions.`,
    action: null, status: 403,
  },
  WORKSPACE_UNRESOLVED: {
    title: 'A workspace could not be looked up',
    message: (p) => `${p.scope ? `Scope ${s(p.scope)}: ` : ''}cc could not say which workspace this session's project is in (${s(p.detail)}); ${p.scope ? 'the scope was' : 'scopes that depend on it were'} not applied to this call.`,
    action: null, status: 502,
  },
  NO_RECALL_SCOPE: { title: 'No scope allows recall', message: () => 'No enabled memory scope grants recall to this session (project, kind and stage are matched against Memory → scopes).', action: null, status: 403 },
  HINDSIGHT_NOT_READY: { title: 'Hindsight is not ready', message: () => 'Hindsight is not running, so this turn has no memory. Open Status to start it.', action: ACTIONS.start, status: 503 },
  RECALL_FAILED: { title: 'Recall failed', message: (p) => `Recall from bank ${s(p.bank)} failed: ${s(p.detail)}`, action: null, status: 502 },
  RETAIN_FAILED: { title: 'Retain failed', message: (p) => `Retaining into bank ${s(p.bank)} failed: ${s(p.detail)}; ${p.origin === 'backfill' ? 'importing again resumes where this stopped' : 'the turns are resent with the next turn'}.`, action: null, status: 502 },
  CURSOR_INVALID: { title: 'Retain progress was unreadable and was reset', message: (p) => (p.file ? 'memory/cursors.json could not be read as a whole; it was moved aside to memory/cursors.json.corrupt and retain progress starts fresh (the next retain of each session starts from its last exchange, without backfilling).' : 'The stored retain progress of this session had an unexpected shape and was discarded; the next retain starts from the last exchange, without backfilling.'), action: null, status: 500 },
  RETAIN_FUTURE: { title: 'A Stop was refused: its turns are stamped in the future', message: () => 'The transcript tail of a Stop carried a timestamp beyond the clock-skew allowance ahead of this machine\'s clock, so it was not recorded (it would have made later Stops look old). Nothing was sent for it.', action: null, status: 409 },
  RETAIN_STALE: { title: 'A late Stop was ignored', message: () => 'A Stop whose turns were already behind the retained position arrived late; nothing was lost and nothing was sent twice.', action: null, status: 409 },
  RETAIN_DROPPED: { title: 'Turns were dropped before they were retained', message: (p) => `Some turns of this session were not retained (${s(p.reason)}). They were not sent to any other bank.`, action: null, status: 503 },
  BANK_RENDER_FAILED: { title: 'A bank template did not render to a valid bank id', message: (p) => `Scope ${s(p.scope)}: ${s(p.detail)}.`, action: null, status: 409 },
  BACKFILL_NO_SCOPES: {
    title: 'No enabled scope retains',
    message: () => 'Importing past sessions needs an enabled memory scope that grants retain: each session is imported only into the bank its retain scope chooses.',
    action: null, status: 409,
  },
  BACKFILL_CC_UNAVAILABLE: {
    title: 'cc could not place the transcripts',
    message: (p) => `Transcripts are placed only through cc, and cc did not answer (${s(p.detail)}). Scan again when cc responds; placements already learned are kept.`,
    action: null, status: 503,
  },
  BACKFILL_STALE: {
    title: 'The scan is out of date',
    message: () => 'Scopes changed since the scan, or a newer scan replaced it; scan again.',
    action: null, status: 409,
  },
  BACKFILL_UNCHECKED: {
    title: 'The scan could not check Hindsight',
    message: () => 'Hindsight was not ready during the scan, so it did not show live overlap or parts already stored; scan again once Hindsight is ready.',
    action: null, status: 409,
  },
  BACKFILL_UNPLACEABLE: { title: 'cc could not place this transcript', message: (p) => `cc has no project for it (${s(p.detail)}); it is not imported anywhere.`, action: null, status: 409 },
  SESSION_LIVE: { title: 'The session is still running', message: () => 'A running session is imported after it ends: scan again then.', action: null, status: 409 },
  NO_RETAIN_SCOPE: { title: 'No scope retains this session', message: () => "No enabled memory scope grants retain to this session's project, kind and stage, so it is not imported anywhere.", action: null, status: 409 },
  LIVE_RETAIN_PENDING: { title: 'Live retain still has turns to send', message: () => 'Live memory holds unsent turns of this session, so where live memory starts is not settled; import it once they are sent.', action: null, status: 409 },
  LIVE_OVERLAP_UNKNOWN: { title: "Live memory's start could not be read", message: (p) => `The session's live document${p.bank ? ` in bank ${s(p.bank)}` : ''} has no readable turn timestamps, so the turns before it cannot be told apart; it is not imported.`, action: null, status: 409 },
  ALREADY_LIVE: { title: 'Already in live memory', message: () => 'Live memory already holds all of this session.', action: null, status: 409 },
  TRANSCRIPT_TOO_LARGE: { title: 'The transcript is too large', message: (p) => `The file is ${s(p.size)} bytes, over the importer's limit of ${s(p.max)}; it is not read.`, action: null, status: 409 },
  TRANSCRIPT_UNREADABLE: { title: 'The transcript could not be read', message: (p) => `Reading the file failed (${s(p.detail)}).`, action: null, status: 409 },
  TRANSCRIPT_SESSION_TOO_LARGE: { title: 'The session is too large to import', message: (p) => `Its turns render to more than ${s(p.max)} characters, the importer's per-session limit; it is not imported.`, action: null, status: 409 },
  TRANSCRIPT_TURN_TOO_LARGE: { title: 'A turn is too large to import', message: (p) => `One turn renders to more than ${s(p.max)} characters, the largest document the importer sends; the session is not imported (nothing is truncated).`, action: null, status: 409 },
  TRANSCRIPT_EMPTY: { title: 'The transcript holds nothing to retain', message: () => 'The file has no user, assistant or tool-call turns.', action: null, status: 409 },
  TRANSCRIPT_CHANGED: { title: 'The transcript changed since the scan', message: () => "It is not what the scan read: its size or modification time changed, the file was swapped for another (a different device or inode, or a symlink), or its content no longer gives the parts the scan showed. Scan again to import it.", action: null, status: 409 },
  LIVE_CUTOFF_MOVED: { title: "Live memory's start moved since the scan", message: () => "The session's live document now starts at a different turn than the scan saw, so the import would differ from what you confirmed. Nothing was sent or deleted for it; scan again.", action: null, status: 409 },
  BUSY: {
    title: 'Another action is running',
    message: (p) => `Wait for "${s(p.job)}" to finish.`,
    action: null, status: 409,
  },
  CONFIRMATION_REQUIRED: {
    title: 'Confirmation required',
    message: (p) => `Type ${s(p.expected)} to confirm.`,
    action: null, status: 400,
  },
  CONTAINERS_RUNNING: {
    title: 'Stop Hindsight first',
    message: () => 'This action needs the Hindsight containers stopped.',
    action: ACTIONS.stop, status: 409,
  },
  IMPORT_PATH_INVALID: {
    title: 'That file cannot be imported',
    message: (p) => `${s(p.path)}: ${s(p.detail)}`,
    action: null, status: 400,
  },
  JOB_NOT_CANCELLABLE: {
    title: 'This job cannot be cancelled',
    message: (p) => `Job ${s(p.job)} ${p.ended ? 'has already ended' : 'is a Docker action, which runs to its end'}.`,
    action: null, status: 409,
  },
  JOB_FAILED: {
    title: 'The action failed',
    message: (p) => `${s(p.job)} failed: ${s(p.detail)}`,
    action: null, status: 500,
  },
  BAD_REQUEST: { title: 'Bad request', message: (p) => s(p.detail), action: null, status: 400 },
  NOT_FOUND: { title: 'Not found', message: (p) => s(p.detail), action: null, status: 404 },
  UNSUPPORTED_MEDIA_TYPE: { title: 'Unsupported content type', message: (p) => `Send ${s(p.expected)}.`, action: null, status: 415 },
  CROSS_SITE: { title: 'Cross-site request refused', message: () => 'This request must come from the plugin page (Sec-Fetch-Site: same-origin or none).', action: null, status: 403 },
  NOT_READY: { title: 'Hindsight is not running', message: () => 'Open Status to start it.', action: ACTIONS.start, status: 503 },
});

/** A named error from the catalog. `params` fill its message and travel to the UI. */
export class AppError extends Error {
  constructor(code, params = {}, { cause } = {}) {
    const entry = CATALOG[code];
    if (!entry) throw new Error(`unknown error code ${code}`);
    super(entry.message(params), cause ? { cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.params = params;
    this.status = entry.status;
  }

  toJSON() {
    return describeError(this.code, this.params);
  }
}

/** The wire form of a catalog error: what `status` and refusals carry. */
export function describeError(code, params = {}) {
  const entry = CATALOG[code];
  return { code, title: entry.title, message: entry.message(params), action: entry.action, params };
}

/** Any thrown value as a catalog error: an AppError as is, anything else as `fallbackCode` carrying its message. */
export function toAppError(err, fallbackCode = 'JOB_FAILED', fallbackParams = {}) {
  if (err instanceof AppError) return err;
  return new AppError(fallbackCode, { ...fallbackParams, detail: err?.message ?? String(err) }, { cause: err });
}
