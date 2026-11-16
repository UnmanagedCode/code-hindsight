> See also: [README](../README.md) · [features.md](features.md) · [architecture.md](architecture.md)

# Interfaces

## Paths the backend serves

cc strips `/plugins/code-hindsight` before a request reaches the backend.

| Path | Owner |
|---|---|
| `/`, `/index.html`, `/theme-init.js`, `/assets/*` | the shell UI from `frontend/dist` (allowlist in `src/http.js`); unbuilt: HTML entries answer `503` text, others fall through |
| `/pluginBridge.js`, `/pluginTheme.css` | `404` (cc serves them at its own root) |
| `/-/api/*` | the plugin's JSON API (below) |
| `/-/hook/{recall,retain,reset}`, `/-/mcp` | the non-browser routes (below) |
| `/-/*` (anything else) | `404` |
| every other path | the Hindsight control plane, proxied ([CP proxy](#cp-proxy)) |

Every response the backend itself produces carries `CSP` (`src/http.js`) and `X-Content-Type-Options: nosniff`; proxied CP responses pass through untouched.

## `/-/api/*`

State-changing requests (`POST`, `PUT`) are refused `403 CROSS_SITE` unless `Sec-Fetch-Site` is `same-origin` or `none` (an absent header is refused too), then need `Content-Type: application/json` (else `415 UNSUPPORTED_MEDIA_TYPE`), except the upload import (`application/octet-stream`). `GET`s need neither.

| Method | Path | Body → answer |
|---|---|---|
| GET | `/-/api/health` | `{ok: true}` — always 200, whatever Hindsight's state (the manifest's `healthPath`) |
| GET | `/-/api/status[?refresh=1]` | `{state, error, docker: {mode, serverVersion}, variant, bindAddress, bindAuto, ports: {api, cp, relay}, images: {api: {ref, present, id, version, ok}, cp: {ref, present, id, basePath, upstream, built, ok}, gpu: {ref, present, id, upstream, cuda, built, ok}} \| null, containers: {api, cp, relay} \| null, startedAt, pendingRestart, volume, lastShutdownFailure: {at, error} \| null, llmMode, compute: {mode: cpu\|gpu, devices: {embeddings, reranker} \| null}, relay: {target: {kind: ollama\|anthropic-loopback, url}, tunnel: {state: connected\|connecting\|stopped, idle, error, address}, lastForward: {at, path, status, error} \| null, upstream: {ok, version, error, at} \| null, problems: [catalog error]} \| null, autoStart?, job, bundles: [{name, size}], bundleNames: {full, slim}}`. `relay` is set only while the API's LLM goes through the relay; it never holds a credential, and `upstream` is the target's cached answer (`problems`: `OLLAMA_UNREACHABLE` or `CC_BACKEND_UNREACHABLE`, and `RELAY_DISCONNECTED`). `refresh=1` re-inspects images and containers first. `autoStart` is cc's flag for this plugin, omitted when cc cannot be asked. `compute.mode` is the saved setting; `compute.devices` is what the running API's local models loaded on (a device name, or `null` for a model with no start line or not local), set once a GPU start passed its check, else `null` |
| GET | `/-/api/settings` | `{settings, secrets: {llmApiKey: bool, embeddingsApiKey: bool}, defaults, detectedBindAddress, choices, images}`. `settings.compute` is one of `choices.computeModes` (`COMPUTE_MODES` in `src/settings.js`); `gpu` refuses `GPU_NEEDS_FULL` (slim) and `GPU_NEEDS_LOCAL_MODEL` (neither model local). `images.gpu` is `API_GPU_IMAGE` |
| PUT | `/-/api/settings` | `{settings, secrets?: {llmApiKey?, embeddingsApiKey?}}` — the whole settings object; a secret string sets, `null`/`""` clears, absent keeps — except that an absent key whose endpoint changed is cleared (`keyEndpoints` in `src/settings.js`: LLM mode/provider/base URL; embeddings provider/base URL). `400 SETTINGS_INVALID` with `params.fields: [{field, code?, message}]` changes nothing. Answers the settings view plus `cleared: [key names]` and `status` |
| GET | `/-/api/scopes` | `{scopes, choices: {actions, kinds, placeholders, limits}}` |
| PUT | `/-/api/scopes` | `{scopes}` — the whole list, validated by `validateScopes` (`src/scopes.js`) and stored in `scopes.json`; `400 SCOPES_INVALID` with `params.fields: [{field: "scopes[i].…", message}]` changes nothing. Answers `{scopes}` |
| POST | `/-/api/memory/preview-bank` | `{template, sample?: {project, worktree, kind}}` → `{bank}` or `{error}` (the same renderer as recall and retain) |
| GET | `/-/api/memory/activity` | `{entries}` newest first; entry `{at, event: recall\|retain\|mcp-recall\|backfill-scan\|backfill-import, outcome: ok\|error\|skipped, sessionId?, project?, worktree?, stage?, kind?, banks?, count?, code?, message?}`. A backfill job adds one summary entry (`count`: sessions ready or imported; `banks`; `message`: the counts; a stopped import is `error` with its `code`, a cancelled one `skipped`; an import's message counts sessions finished and documents sent separately, since a stopped session may have sent some), plus one `error` entry per session Hindsight refused |
| GET | `/-/api/memory/backfill` | `{scan: <the latest backfill scan> \| null}` — held in memory, so `null` after a backend restart ([Backfill](#backfill)) |
| GET | `/-/api/memory/stages` | `{stages: [{name, playbooks: [id]}], error}` — stage names across cc's playbooks; `error` is a string when cc could not be read |
| GET | `/-/api/memory/cc-projects` | `{projects: [{name, workspace: string\|null}], workspaces: [{name, projectCount}], error}` — cc's projects (with the workspace each is in) and workspaces, both by name, for the scope editor's suggestions. Always 200: a list that could not be read is `[]` and `error` is the first failure's message (else `null`) |
| GET | `/-/api/cc-backends` | `{backends: [{id, label, kind: anthropic\|ollama\|null, host, loopback, freeModel?, usable, refusal, daemon?: {reachable, version, error}, models: [{model, label, cloud?, source?: cc\|daemon}]}]}` — never a token. `loopback`: a plain-HTTP loopback endpoint, reached through the relay. `freeModel` (Anthropic rows): the row names no concrete model, so the picker also takes a typed id; `models` are cc's list without Claude Code's launch tag (a trailing `[…]`) plus the concrete `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` values (a `{model}` placeholder is not one). `daemon`, `cloud` and `source` are on Ollama rows only; the route asks the daemon only when such a row exists, and a daemon failure is `daemon.reachable: false`, not an error |
| POST | `/-/api/start` | start / reconcile to the saved settings; answers status at once |
| POST | `/-/api/restart` | stop, then start; answers status at once |
| POST | `/-/api/stop` | stop the containers (kept); answers status when stopped |
| POST | `/-/api/jobs/<kind>` | start a job (below); answers the job (`state: "running"`); `409 BUSY` while another job of any kind runs |
| POST | `/-/api/jobs/<id>/cancel` | `{}` → the job; asks a running, cancellable job to stop (it ends `cancelled`). `404 NOT_FOUND`; `409 JOB_NOT_CANCELLABLE` for a Docker job or one that has ended |
| POST | `/-/api/jobs/import` (`application/octet-stream`) | the body is streamed into `docker load`; answers the finished job |
| GET | `/-/api/jobs` | `{jobs: [...]}` (most recent first, no tails) |
| GET | `/-/api/jobs/<id>` | `{id, kind, state: running\|done\|failed\|cancelled, startedAt, endedAt, result, error, progress: {done, total, unit} \| null, cancellable, tail}` — `progress` and `cancellable` are set by the backfill jobs; Docker jobs report `null` and `false` |
| GET | `/-/api/logs/<api\|cp\|relay>` | `{role, log}` — last 200 lines of the container's log |
| GET | `/-/api/bundles/<name>` | the bundle file (`application/x-tar`, attachment); only names the plugin wrote into its bundle dir |

**Errors** answer the catalog entry `{code, title, message, action, params}` with the entry's HTTP status (`CATALOG` in `src/errors.js`). The same shape is `status.error` and `job.error`.

### Jobs

| `<kind>` | Body | Result |
|---|---|---|
| `pull` | `{variant: "full"\|"slim"}` | `{image, id}` — `id` is the pulled image's ID (`null` if absent) |
| `build-cp` | `{}` | `{image, id}` — the built image's ID |
| `build-gpu` | `{}` | `{image, id}` — `API_GPU_IMAGE` and its ID; fails `IMAGE_MISSING` (`API_IMAGES.full`) before running anything when the full image is absent, `GPU_IMAGE_MISSING` when the result lacks the GPU build labels |
| `import` | `{path: "/abs/file.tar"}` (or the octet-stream upload) | `{loaded: [{ref, id, status: pinned\|wrong-build\|unused}], manifest: <code-hindsight-bundle.json> \| null}` |
| `export` | `{variant}` | `{name, path, size, sha256, images: [{ref, id}]}` |
| `remove-images` | `{confirm: true}` | `{removed: [refs]}` (the pinned API refs and `CP_IMAGE` that were present) |
| `delete-volume` | `{confirm: "<volume name>"}` | `{removed: "<volume name>" \| null}` (`null` when there was no volume) |
| `backfill-scan` | `{fresh?: boolean}` | `{scanId, totals, hindsightChecked}`; the full scan is `GET /-/api/memory/backfill`. Refused `BACKFILL_NO_SCOPES` (no scope grants retain), `BACKFILL_CC_UNAVAILABLE` (no `CONDUCTOR_URL`), `SCOPES_INVALID`; fails `BACKFILL_CC_UNAVAILABLE` after `BACKFILL_LIMITS.ccFailuresMax` consecutive cc failures |
| `backfill-import` | `{scanId, sessions: [key], confirm: true}` (body up to `BACKFILL_LIMITS.selectionMaxBytes`) | `{sessions, documents: {sent, replaced, alreadyImported, queued, retried, deleted}, failed: [{key, code, message}], skipped: [{key, code, message}], banks}`. Refused `CONFIRMATION_REQUIRED` (`params.expected: "confirm: true"`), `BACKFILL_STALE` (not the latest scan, or the saved scopes changed since), `BACKFILL_UNCHECKED` (the scan ran with `hindsightChecked: false`), `BAD_REQUEST` (an empty list, or a key that is not a `ready` row of that scan), `HINDSIGHT_NOT_READY` |

- `remove-images` and `delete-volume` refuse `CONFIRMATION_REQUIRED` without their confirmation and fail `CONTAINERS_RUNNING` while a container of this plugin runs.
- `build-cp` inspects `BUILD_HELPER` (a tag), pulls it when missing, then runs `docker run --rm --name <prefix>-build -v /var/run/docker.sock:/var/run/docker.sock <BUILD_HELPER> docker buildx build <repo>#<UPSTREAM_TAG> …` (`buildCpCommand` in `src/jobs.js`).
- `build-gpu` ensures `BUILD_HELPER` the same way, then runs `docker run --rm -i --name <prefix>-build -v /var/run/docker.sock:/var/run/docker.sock <BUILD_HELPER> docker buildx build --build-arg HINDSIGHT_VERSION=… --build-arg PYTORCH_CUDA_FLAVOR=GPU_TORCH_FLAVOR --build-arg PYTORCH_CUDA_INDEX=GPU_TORCH_INDEX --label io.code-hindsight.upstream=… --label io.code-hindsight.cuda=… --label io.code-hindsight.recipe=GPU_RECIPE_PATH -t API_GPU_IMAGE --load -` with `src/gpu/Dockerfile` on stdin (no build context) (`buildGpuCommand` in `src/jobs.js`). `remove-images` also removes `API_GPU_IMAGE` when present.
- After a successful `pull`, `build-cp`, `build-gpu` or `import`, Hindsight starts if it was asked to run and is in `error`; the other Docker jobs only re-read images and containers. The backfill jobs never resolve docker and never touch Hindsight's lifecycle.
- One job runs at a time across all kinds. `backfill-scan` and `backfill-import` are cancellable: they stop at their next file, document or request.

### Backfill

**Scan view** (`GET /-/api/memory/backfill`):

```
{scanId, scannedAt, scopesHash, hindsightChecked, llm: {mode, model|null}, basis: BACKFILL_ESTIMATE,
 totals: {files, ready, imported, skipped, cached, resolved, estimate: {chunks, inputTokens, outputTokens}},
 sessions: [{key: "<handle>:<backingId>", handle, backingId, project, worktree, kind, stage|null, title|null,
             modifiedAt, firstAt, lastAt, turns, documents, chars, bank, scope, status: ready|imported,
             cutoffAt|null, untimed, malformed, oversized, stored, outdated, orphans,
             estimate: {chunks, inputTokens, outputTokens}}],
 skipped: [{key, handle|null, backingId, project?, worktree?, stage?, code, message}]}
```

- `sessions` are ordered by `modifiedAt` (the transcript file's mtime), newest first; equal times keep transcript path order. `firstAt`/`lastAt` bound only the turns that would be imported (before `cutoffAt`), so they are not the order.
- `scopesHash`: SHA-256 of the saved scopes' JSON at scan time; an import against another hash is `BACKFILL_STALE`.
- `hindsightChecked: false`: Hindsight was not ready (or failed mid-scan), so live overlap and earlier imports were not checked for the rest. A transcript that cannot be read is skipped on its own (`TRANSCRIPT_UNREADABLE`) and leaves the checks on.
- `status: imported`: every part is stored (below) and none is orphaned; otherwise `ready`, with `stored`, `outdated` and `orphans` counting the bank's parts.
- A scan opens each transcript at most once (not at all when the cached summary applies and there is no cutoff).
- `totals.estimate` sums the `ready` rows. `cutoffAt` is live memory's first turn time; `turns`, `documents`, `chars` and `estimate` then count only the earlier turns, and `untimed` the turns left out for want of a timestamp.
- `estimate` per document of `chars` characters (`estimateDocument`, `src/backfill.js`): `chunks = ceil(chars / chunkChars)`; `inputTokens = ceil(chars / charsPerToken) + chunks × promptTokensPerChunk`; `outputTokens = chunks × outputTokensPerChunk`; LLM mode `none`: both token counts 0.
- Skip codes and their meaning: [features → Import past sessions](features.md#import-past-sessions).

**Placement** (`placeTranscript`, `src/ccSession.js`), for each top-level regular file `<id>.jsonl` (`id` a cc session id) in each directory of the transcripts root; symlinks and subdirectories are ignored:

1. `describe_session {sessionId: <backing id>}`: `{ok: false, code: "SESSION_NOT_A_HANDLE", handle}` → describe `handle` (once per handle per scan); a row → that row, its `sessionId` the handle; `SESSION_UNLOCATABLE` / `SESSION_UNKNOWN` → `BACKFILL_UNPLACEABLE` (cached); no answer, an HTTP error or another shape → `BACKFILL_UNPLACEABLE` "cc did not answer" (not cached). Deadline `BACKFILL_LIMITS.describeTimeoutMs`.
2. A `live` row → `SESSION_LIVE` (not cached). A `retired` row → session `{sessionId: handle, project, worktree: worktree ?? "main", kind: conductor iff project is .conduct, stage: retired.stage, playbook: retired.playbook}`, display title `retired.title`. No other source (no in-file `cwd`, no directory name).
3. Scopes as for live retain (`withWorkspace`, `matchScopes(...).retain`).

**Overlap** per handle, at scan and again at import: a cursor entry with `inflight` or a non-empty `pending` (read through `cursors.peeker()`, which parses `cursors.json` at most once per job run and never writes it) → `LIVE_RETAIN_PENDING`. Then `GET …/documents/cc-session:<handle>` in every bank a retain scope's template renders for the session (matching or not): the earliest parseable `timestamp` of its `original_text` lines is the cutoff (the earliest across banks); `original_text` null or no timestamp → `LIVE_OVERLAP_UNKNOWN`. Only turns stamped strictly before the cutoff are imported.

**Documents:** one segment file's turns (the same reader rules as live retain), streamed and never held whole, are split at turn boundaries into parts of at most `BACKFILL_LIMITS.documentMaxChars` rendered characters. A single longer turn skips the session (`TRANSCRIPT_TURN_TOO_LARGE`), as does a file whose turns render past `BACKFILL_LIMITS.sessionMaxChars` (`TRANSCRIPT_SESSION_TOO_LARGE`); nothing is truncated. Part `n` (from 1) is document `cc-backfill:<handle>:<backingId>:p<n>`, retained with `update_mode: "replace"` and `operation_id = operationIdFor(bank, documentId, first turn id, last turn id, content hash)` (`contentHash`: SHA-256 of the part's content). A part is **stored** when the document exists and the SHA-256 of its `original_text` equals the part's; **outdated** when it exists with other content; **orphaned** when it is numbered past the current parts (found by probing upwards across gaps until `BACKFILL_LIMITS.orphanProbeMisses` consecutive numbers are missing). The scan keeps, per row, the plan the user confirms: the cutoff, each part's hash, and the orphan part numbers it found.

Import, per session in scan order, acting only on the confirmed plan: `lstat` must still show the same regular file (size, mtime, `dev`, `ino`), else `TRANSCRIPT_CHANGED`; overlap again, and a cutoff other than the scan's → `LIVE_CUTOFF_MOVED`; the file is summarised once, and a part count or any part hash other than the scan's → `TRANSCRIPT_CHANGED`. Either skip sends and deletes nothing for the session. Then, per part: stored → `alreadyImported`; else operation status `failed`/`cancelled` → retry (`retried`); `pending`/`processing`/`completed` → `queued`; not found → retain (`replaced` when it was outdated, else `sent`), the parts to send read in a second streaming pass one part at a time (a part whose hash no longer matches, or a planned part the pass does not yield → `TRANSCRIPT_CHANGED`). Then the orphan parts the scan listed, and only those, are deleted highest first (`deleted`; a missing one is not counted), so an interrupted run leaves a block the next scan finds. A session that stops part-way still adds what it sent to the counts. One request at a time. A `RETAIN_FAILED` with an HTTP 4xx `params.status` other than 401/403 fails that session; any other failure (401/403 included) stops the job.

### Transcripts root

`$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` (Claude Code's own rule; `claudeProjectsDir` in `src/config.js`). Read only by `backfill-scan` and `backfill-import`.

### Image references (`src/pins.js`, `src/trust.js`)

| Image | Runs when |
|---|---|
| API (`API_IMAGES[variant]`) | the pinned tag is present (else `IMAGE_MISSING`) |
| CP (`CP_IMAGE`) | present (else `CP_IMAGE_MISSING`) with the base-path and upstream-tag labels (else `CP_IMAGE_MISMATCH`; `isOurCpBuild`). An image labelled with anything else, such as a commit hash, is a mismatch: **Build CP image** once rebuilds it under the current labels |
| GPU (`API_GPU_IMAGE`), Compute `gpu` only (it replaces the API image) | present (else `GPU_IMAGE_MISSING`) with the `io.code-hindsight.recipe` = `GPU_RECIPE_PATH`, upstream-tag (`UPSTREAM_TAG`) and `io.code-hindsight.cuda` = `GPU_TORCH_FLAVOR` labels (else `GPU_IMAGE_MISMATCH`; `isOurGpuBuild`). The official API image is not needed then |
| Build helper (`BUILD_HELPER`) | the pinned tag, pulled when missing; `runHelper` refuses any other ref |

- Containers run by the image ID the tag resolved to at start; a different ID recreates them.

### Bundles

An export is the `docker save` archive with one extra root file, `code-hindsight-bundle.json` (`BUNDLE_MANIFEST`): `{format: 1, hindsight, variant, images: [{ref, id}], createdAt}`. `docker load` ignores it; the import job reads it back. It is informational: nothing checks it.

## Hook and tool routes (`src/hookRoutes.js`)

Called by Claude Code hooks (through cc's plugin proxy) and by cc's plugin MCP forwarding; never by the shell UI.

- **Request policy:** `POST` with `Content-Type: application/json` only. Refused `403 BROWSER_REFUSED` when the request carries `Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Dest` or `Sec-Fetch-User` (the invariant relied on: a browser's non-GET/HEAD request always carries `Origin`, whose value may be `null`, and an `application/json` body cannot be sent as a simple or form request; `Sec-Fetch-*` adds to that where the browser sends it, and some omit it on non-trustworthy HTTP origins. The check fails open only for a client that sends none of these, i.e. a non-browser local process, as the trust model already says. Node's `fetch` adds only `Sec-Fetch-Mode`, which is not a refusal reason). `/-/mcp` is also refused when it carries `X-Forwarded-Prefix` (cc's public proxy adds it; its MCP forward dials the backend directly). Body limits: `HOOK_BODY_LIMITS` (`413` over). `sessionId` must be a cc session id.
- **Identity:** the claimed `sessionId` must be a **live** cc session; scopes are matched against what cc's `describe_session` says about it at call time (and, when a scope needs it, the workspace cc's `list_projects` places its project in). It is advisory, not authenticated: see [README → Trust model](../README.md#trust-model).

| Path | Body → answer |
|---|---|
| `/-/hook/recall` | `{sessionId, prompt}` → `200 {context}` (`context` is the `<hindsight_memory>` block or `null`; never an error). The memories count as injected only after the answer is flushed. A session that matches no recall scope produces no activity entry (every prompt would add one); the `/-/mcp` tool does log `NO_RECALL_SCOPE` |
| `/-/hook/retain` | `{sessionId, turns: [{id, role: user\|assistant\|action, content, timestamp\|null}]}` → `202 {status: accepted\|off\|empty\|unresolved\|error}`; sending to Hindsight happens after the answer, one retain in flight per session with a bounded, persisted backlog of windows behind it (a loss is logged `RETAIN_DROPPED` in the activity log and never sent to another bank; see [architecture](architecture.md#memory)) |
| `/-/hook/reset` | `{sessionId}` → `200 {ok: true}` |
| `/-/mcp` | cc's forward: `{tool: "recall", arguments: {query}, caller: {sessionId, project}, format}` → always `200 {text}` or `{error, code}` (`NO_SESSION`, `SESSION_NOT_LIVE`, `SESSION_UNRESOLVED`, `WORKSPACE_UNRESOLVED`, `NO_RECALL_SCOPE`, `HINDSIGHT_NOT_READY`, `RECALL_FAILED`, `BAD_REQUEST`; an unknown tool has no code). The banks searched are exactly what the scopes yield for `caller.sessionId` now; arguments cannot add one |

### Hook process (`claude/hooks/hook.mjs`)

`hook.mjs recall|retain|reset` reads the hook input from stdin and posts to `<base>/-/hook/<event>`, where `<base>` is `$CODE_HINDSIGHT_HOOK_URL` if set, else `$CONDUCTOR_URL/plugins/code-hindsight`. It identifies the session by `$CC_SESSION_ID` (the public id, not the hook input's rotating backing `session_id`). With no `CC_SESSION_ID`, or no base, it makes no request. It **always exits 0**, writes nothing to stderr, and writes stdout only for `recall` (one `hookSpecificOutput` JSON). Deadlines: `HOOK_TIMEOUTS` in `claude/hooks/limits.mjs`; `CODE_HINDSIGHT_HOOK_TIMEOUT_MS` overrides them (tests only). `retain` parses `transcript_path` with `claude/hooks/transcript.mjs`, waits briefly for the transcript to hold `last_assistant_message` and otherwise adds it as a synthetic turn `final:<last uuid>`, and sends the newest turns within `RETAIN_TAIL_BYTES`.

`claude/hooks/hooks.json`: `UserPromptSubmit` → `recall`; `Stop` → `retain` with `async: true`; `SessionStart` matcher `clear|compact` → `reset`. `Stop` must exit 0 and print nothing: exit 2, `decision: "block"` or `additionalContext` on a Stop hook keeps the session running.

### Hindsight calls (`src/hindsightClient.js`)

| Call | Detail |
|---|---|
| recall | `POST /v1/default/banks/<bank>/memories/recall` `{query, budget, max_tokens}` (`RECALL_BUDGET`, `RECALL_MAX_TOKENS`); **no `types` filter** (LLM none stores `world` chunks); `404` (bank never created) is an empty result |
| retain | `POST /v1/default/banks/<bank>/memories` `{items: [{content, document_id: "cc-session:<id>", update_mode: "append", timestamp, context, metadata}], async: true, operation_id}`; creates a missing bank, and an append onto a missing document stores the content as a new document. `content` is JSONL, one `{role, content, timestamp}` per turn. `metadata`: `source`, `ccSessionId`, `project`, `worktree`, `kind`, `stage` (omitted without one) |
| `operation_id` | `operationIdFor` (`src/retainCursor.js`): a v4-shaped UUID from the SHA-256 of `bank`, document id, first and last turn id, so a resend of a batch repeats it and Hindsight returns the original operation |
| backfill retain | as retain, but `document_id: "cc-backfill:<handle>:<backingId>:p<n>"`, `update_mode: "replace"`, `timestamp` = the part's first parseable turn timestamp (else the file's mtime), context suffixed "Imported from the session's saved transcript after it ended.", `metadata` adds `origin: "backfill"`, `segment: <backingId>`, `part: "<n>"` (every value a string) |
| document | `GET /v1/default/banks/<bank>/documents/<document id>` → `original_text`; `404` = none (backfill: earlier imports and live overlap). `DELETE` the same path removes it and the memories extracted from it (backfill: orphaned parts only); `404` = already gone |
| operation | `GET /v1/default/banks/<bank>/operations/<operation id>` → `status: pending\|processing\|completed\|failed\|cancelled\|not_found`; `404` = not found. `POST …/operations/<operation id>/retry` re-runs a failed one (backfill only) |

## Hindsight states

`stopped → checking → starting → ready`, plus `stopping` and `error` (with `error` set). `ready` means the API answered `/health` with 200, the CP answered `<base path>/api/health`, and the backend signed in to the CP.

## Data dir (`$CONDUCTOR_PLUGIN_DATA_DIR`, mode 0700)

| File | Content |
|---|---|
| `settings.json` (0600) | the settings; never a key. A file without a key reads that key's default (`DEFAULT_SETTINGS`), so an older file reads `compute: cpu` |
| `secrets.json` (0600) | `apiKey`, `cpAccessKey`, `relayKey` (generated once), `llmApiKey`, `embeddingsApiKey` |
| `stopping.json` (0600) | `{pid, at}` of the detached `docker stop` a SIGTERM left running; the next backend waits for that pid |
| `shutdown-failed.json` (0600) | `{at, error}` when a SIGTERM could not start that stop; shown as `status.lastShutdownFailure` and removed when Hindsight is next ready |
| `scopes.json` (0600) | `{scopes}`: the memory scopes; absent = memory off |
| `memory/cursors.json` (0600) | per `CC_SESSION_ID`: `{lastId, lastTs, inflight?, pending, at}` — the last retained turn; the batch being sent (kept so a retry resends it unchanged); and `pending`, the windows of unsent turns `{bank \| null, session, lastId, lastTs}` in order, each with the bank its own stage chose. A Stop whose tail carries a timestamp more than `MEMORY_LIMITS.clockSkewMs` ahead of the backend's clock is refused and logged `RETAIN_FUTURE` (it would otherwise make later Stops look old). A Stop whose tail is provably older than the newest recorded end is ignored (best effort where nothing can be proven). An entry of the wrong shape is dropped (`CURSOR_INVALID`); a file unreadable as a whole is moved aside to `memory/cursors.json.corrupt`. Turn ids must be non-empty and at most `TURN_ID_MAX` characters (else `400`); entries older than `CURSOR_MAX_AGE_MS` are pruned on write. Losing it can duplicate turns |
| `memory/backfill-placements.json` (0600) | `{version: 2, files: {"<dir>/<backingId>.jsonl": {size, mtimeMs, handle, outcome: placed\|unplaceable, session?, title?, detail?, summary?: {totalTurns, totalChars, turns, firstAt, lastAt, parts: [{chars, hash, firstId, lastId}], turnTooLarge, sessionTooLarge, malformed, oversized, …}}}}` (the summary of the whole file, without a cutoff) — what cc said about each transcript and its parse summary, used while the file's size and mtime are unchanged; cc's settled refusals are kept, live sessions and cc failures never. Entries of files gone are pruned after each scan; `fresh` rewrites it. Unreadable as a whole, or of another version (`PLACEMENTS_VERSION`, `src/backfillPlacements.js`) → moved aside to `memory/backfill-placements.json.corrupt` and rebuilt. Never holds transcript text |
| `logs/memory.jsonl` (+ `.1`) | the activity log (rotated at `ACTIVITY_LIMITS.rotateBytes`) |
| `run/` | short-lived `--env-file`s for `docker run`, removed after each run |
| `logs/jobs/<id>.log` | each job's output |
| `bundles/code-hindsight-<version>-<variant>.tar` (0600) | exported bundles |

## Docker resources

All names derive from `RESOURCE_PREFIX` (`src/pins.js`) through `resourceNames` (`src/containerSpec.js`): `<prefix>-api`, `<prefix>-cp`, `<prefix>-net`, `<prefix>-data`, `<prefix>-build` (the CP build helper), `<prefix>-relay` (the relay; only while a backend is linked through the relay). The plugin never touches a container, volume or network outside the prefix, and never connects anything to a network.

Labels (`LABELS` in `src/pins.js`):

| Label | On | Value |
|---|---|---|
| `io.code-hindsight.managed` | containers, network, volume | `1` |
| `io.code-hindsight.owner` | containers, network, volume | `ownerId(dataDir)`: a resource with our name and another owner is refused `NAME_TAKEN` |
| `io.code-hindsight.role` | containers | `api` / `cp` / `relay` |
| `io.code-hindsight.spec` | containers | hash of image ID, run arguments and env; a mismatch recreates the container |
| `io.code-hindsight.embeddings` | volume | `local` or `<provider>:<model>`; a mismatch with the settings is `EMBEDDINGS_CHANGED` |
| `io.code-hindsight.basePath`, `io.code-hindsight.upstream` | CP image | the base path and upstream release tag (`UPSTREAM_TAG`) it was built with; checked before start (`CP_IMAGE_MISMATCH`) |
| `io.code-hindsight.recipe`, `io.code-hindsight.upstream`, `io.code-hindsight.cuda` | GPU image | the recipe it was built from (`GPU_RECIPE_PATH` in `src/gpuRecipe.js`), the upstream release tag that recipe derives from, and the CUDA torch flavour; checked before a GPU start (`GPU_IMAGE_MISMATCH`). An edit to the recipe at the same version is not detected: run **Build GPU image** after one |

### Container environment (`apiSpec` / `cpSpec` in `src/containerSpec.js`)

- Both run by the image ID the pinned tag resolved to at start (the last `docker run` argument).
- **API** (`<prefix>-api`, alias `api` on `<prefix>-net`, `-p <bind>:<apiPort>:8888`, volume at `/home/hindsight/.pg0`, `--restart on-failure:3`, `--shm-size <API_SHM_SIZE in src/containerSpec.js>`: pg0 vector-index builds use `/dev/shm`, and Docker's 64 MiB default fails bank creation): `HINDSIGHT_ENABLE_CP=false`, `HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension`, `HINDSIGHT_API_TENANT_API_KEY`; full image: `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; LLM: `HINDSIGHT_API_LLM_PROVIDER` (`none` by default), `_MODEL`, `_BASE_URL`, `_API_KEY`; `HINDSIGHT_API_EMBEDDINGS_PROVIDER` (+ `_OPENAI_MODEL`, `_OPENAI_BASE_URL`, `_OPENAI_API_KEY`), `HINDSIGHT_API_RERANKER_PROVIDER`. Compute `gpu`: the GPU image's ID, plus `--gpus all`, `HINDSIGHT_API_RERANKER_LOCAL_FP16=true` and `TORCH_DISABLE_NATIVE_JIT=1` (torch's Triton-backed ops need a C compiler the image lacks; without it the reranker fails at start with `Failed to find C compiler`); Compute `cpu` adds none of them, so its spec hash is unchanged.
- **CP** (`<prefix>-cp`, on `<prefix>-net`, `-p <bind>:<cpPort>:9999`, `--restart on-failure:3`): `HINDSIGHT_CP_DATAPLANE_API_URL=http://api:8888`, `HINDSIGHT_CP_DATAPLANE_API_KEY`, `HINDSIGHT_CP_ACCESS_KEY`.
- Env reaches `docker run` through a 0600 `--env-file`, never the command line.
- **Relay** (`relaySpec`; `<prefix>-relay`, alias and API-side port from the active target's entry in `RELAY_TARGETS` in `src/pins.js`, `-p <bind>:<relayPort>:<RELAY_TUNNEL_PORT>`, only the tunnel port published, `--read-only --cap-drop ALL --security-opt no-new-privileges`, `--restart on-failure:3`): runs the API image's ID with `--entrypoint node --input-type=module -e <src/relay/relay.mjs>`, so its spec hash follows the script. Env set by the plugin: `RELAY_KEY`, `RELAY_API_PORT`, `RELAY_TUNNEL_PORT`, `RELAY_MAX_WAITING` (`LLM_MAX_CONCURRENT_MAX` in `src/settings.js`). Optional, with defaults in `src/relay/relay.mjs`: `RELAY_WAIT_MS` (how long an API connection waits for an idle tunnel), `RELAY_HANDSHAKE_MS`, `RELAY_ACK_MS` (how long a paired tunnel may take to ack), `RELAY_MAX_HANDSHAKING` (tunnel sockets still in their handshake). Created before the API while linked (a change of target recreates it: its spec hash includes the alias and port); removed when unlinked.
- **Ollama mapping** (cc backend whose launch command starts with `ollama`): `HINDSIGHT_API_LLM_PROVIDER=ollama`, `_MODEL=` the chosen model, `_BASE_URL=http://<alias>:<apiPort>/v1` (the `ollama` entry of `RELAY_TARGETS`), `_API_KEY=` the relay key (the provider sends it as a Bearer token).
- **Anthropic-loopback mapping** (cc backend whose `ANTHROPIC_BASE_URL` is a plain-HTTP loopback address): `HINDSIGHT_API_LLM_PROVIDER=anthropic`, `_MODEL=` the chosen model as written, `_BASE_URL=http://<alias>:<apiPort>` (the `anthropic-loopback` entry of `RELAY_TARGETS`, no path), `_API_KEY=` the relay key (the SDK sends it as `x-api-key`). The row's own token never enters the container env.
- **`HINDSIGHT_API_LLM_MAX_CONCURRENT`** is set from `llm.maxConcurrent` in every non-`none` mode when it is not null.
- **Cc-backend mapping** (a non-loopback row): `HINDSIGHT_API_LLM_PROVIDER=anthropic`, `_BASE_URL=` the row's `ANTHROPIC_BASE_URL`, `_API_KEY=` its `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, `_MODEL=` the chosen model. The token is sent as Anthropic's `x-api-key`.

### Relay tunnel (`src/relayTunnel.js`, `src/relay/relay.mjs`, `src/relayProxy.js`)

- The plugin keeps idle TCP connections to `<bind>:<relayPort>`; each sends `HSR1 <relayKey>\n` (at most 256 bytes, within `RELAY_HANDSHAKE_MS`, else closed).
- For each API connection the relay writes the go byte `0x01` to an idle tunnel. The plugin takes the socket over and answers one ack byte; only then does the relay pipe the API's bytes. The API connection is closed if no tunnel is idle within `RELAY_WAIT_MS`. The ack is time-bounded: a paired tunnel that does not ack within `RELAY_ACK_MS` is closed together with its API connection.
- Caps evict the **oldest**, never the newcomer: at `RELAY_MAX_HANDSHAKING` the oldest unauthenticated socket is closed (a fresh connection is always admitted, but a sustained high-rate connect flood can still evict it before its handshake is read), and at `RELAY_MAX_WAITING` the oldest waiting API connection is closed. The waiting cap equals the largest `llm.maxConcurrent`, so no more calls can be waiting than the API may make at once. There is no per-source cap: the published tunnel port reaches the relay from the plugin network's gateway address whoever connects, so the plugin cannot be told from other host traffic. On the API side, evicting the oldest waiting connection is a deliberate trade: a party on the bridge network can push out a waiting legitimate API connection, but only while no idle tunnel exists, and the cap equals the largest `llm.maxConcurrent`. The relay logs one line per kind per interval, with a count of the suppressed ones.
- One target is active at a time (`RELAY_TARGETS`, chosen at each start; the proxy reads it when each request arrives, so a keep-alive connection follows a switch and an in-flight request keeps the target it began with). The plugin serves each tunnelled connection as HTTP, in this order:
  1. no active target: `503`;
  2. the relay key missing or wrong in the target's `keyHeader` (`authorization` as `Bearer <relayKey>` for Ollama; `x-api-key` as the raw key for anthropic-loopback; the other form is not accepted): `401`;
  3. a request target that is not a normalised origin-form path (absolute-form, fragment, dot segments, backslash, `//`): `400`;
  4. a `METHOD path` outside the target's `allowed`: `403`;
  5. otherwise the request is streamed to the target and the answer streamed back.
- **Header rewrite.** `authorization`, `x-api-key` and the hop-by-hop headers are always dropped. For anthropic-loopback the plugin injects the row's token in the row's own form: `Authorization: Bearer <token>` for `ANTHROPIC_AUTH_TOKEN` (which wins), `x-api-key: <token>` for `ANTHROPIC_API_KEY`. Every other header (`anthropic-version`, `anthropic-beta`, `content-type`) and the body pass through. The token exists only in the plugin process: it is read from cc at each start, handed to the proxy with the target, and dropped when the relay stops; no status, route, log line, error parameter or `lastForward` holds it.
- **Upstream URL.** Ollama: `OLLAMA_HOST`. anthropic-loopback: the row's `ANTHROPIC_BASE_URL` origin, its path (without a trailing `/`) and then the checked path and query, as the SDK would build it directly. Only `http:` loopback rows are relayed; loopback over `https` is refused `CC_BACKEND_LOOPBACK`.
- A target connect failure is `502` and recorded in `status.relay.lastForward` as `OLLAMA_UNREACHABLE` or `CC_BACKEND_UNREACHABLE`.
- **Probe** (Status, cached for `RELAY_PROBE_CACHE_MS`, reset when the target changes): Ollama through `GET /api/version`; anthropic-loopback through an unauthenticated request to the row URL, where any HTTP answer, a 404 included, counts as answering. Ollama's picker also reads `GET /api/tags` (a model with `remote_host` is cloud).

### Unauthenticated paths

The API and control-plane ports (and, while a backend is linked through the relay, the relay tunnel port) need a key except: API `/health*`, `/version`, `/metrics`, `/docs`, `/openapi.json`; CP `<base path>/login`, `/api/auth/*`, `/api/health`, `/api/version` and static assets. None returns memory data.

## CP proxy

`src/cpProxy.js`, for every path not listed in [Paths](#paths-the-backend-serves):

- **Upstream path:** `<BASE_PATH><path>?<query>` on `http://<bind>:<cpPort>`; `Host` is the upstream; `X-Forwarded-*`, `Forwarded` and `X-Real-IP` are dropped.
- **Location:** a root-relative `Location` under `BASE_PATH`, or an absolute one on the upstream origin, is returned root-relative without `BASE_PATH` — cc adds `/plugins/<id>` to every root-relative `Location` (even one that already carries it). Others pass unchanged.
- **Cookies:** the browser's `hindsight_cp_access` is dropped and the backend's session is added; a `Set-Cookie` for `hindsight_cp_access` is removed; other CP cookies get `Path=<BASE_PATH>`.
- **Session:** the backend signs in with `POST <BASE_PATH>/api/auth/login {key}` and renews before the CP's 24 h expiry. A `401` carrying `x-hindsight-session-required`, or a redirect to `/login`, signs in again; `GET`/`HEAD` are retried once, other methods pass the `401` through.
- **Local answers:** `/api/auth/logout` → `200 {success: true}`; `/login?returnTo=<app path>` → `302` to that path (else `/dashboard`).
- **Fetch metadata:** every request, whatever its method, is refused `403 CROSS_SITE` unless `Sec-Fetch-Site` is `same-origin` or `none`; a request without the header is refused, not forwarded without credentials (some CP `GET`s act, e.g. a document export, and the proxy adds the session). cc's frame, the shell's nested frame and navigation inside it are all `same-origin`.
- **Not ready:** while Hindsight is not `ready`, `503` HTML naming the current error (text-escaped).
- Bodies stream both ways; an aborted client aborts the upstream request; connect timeout 10 s, no total timeout.

## cc routes the backend reads

| Route | Used for | On failure |
|---|---|---|
| `GET $CONDUCTOR_URL/api/settings/models` (`backends[].{id,label,template,env:[{key,value}]}`, `backendModels`) | the cc-backend link and its picker (`template` decides an Ollama row); a row whose `ANTHROPIC_BASE_URL` host is loopback (`isLoopbackHost` in `src/llmEnv.js`, over the WHATWG-normalized host; best-effort, literal addresses and `localhost`) is linked through the relay when its scheme is `http:`, and refused `CC_BACKEND_LOOPBACK` otherwise | `CC_UNREACHABLE` / `CC_ROUTE_CHANGED` |
| `GET $CONDUCTOR_URL/api/plugins/code-hindsight/status` (`autoStart`) | the Auto-start hint | hint omitted |
| `POST $CONDUCTOR_URL/mcp/tools/describe_session` `{sessionId}` (`live.{project, worktree.worktreeName, playbook, stage}`) | placing a session for scope matching, on every hook or tool call (deadline: `DESCRIBE_TIMEOUT_MS` at Stop and import; the shared `MEMORY_LIMITS.recallDeadlineMs` on recall); kind is `conductor` iff `live.project` is `.conduct` | `SESSION_UNRESOLVED`; no `live` arm or `SESSION_UNKNOWN` → `SESSION_NOT_LIVE` |
| the same, with a transcript's backing id, then its handle (`SESSION_NOT_A_HANDLE.handle`; a retired row's `project`, `worktree`, `retired.{stage, playbook, title}`) | placing a saved transcript for the backfill scan ([Backfill](#backfill)); deadline `BACKFILL_LIMITS.describeTimeoutMs`, one call at a time | `SESSION_UNLOCATABLE` / `SESSION_UNKNOWN` → `BACKFILL_UNPLACEABLE`; no answer → the same, uncached; repeated → `BACKFILL_CC_UNAVAILABLE` |
| `GET $CONDUCTOR_URL/api/playbooks`, `GET …/api/playbooks/<id>` (`stages` keys) | the stage suggestions in the Memory tab (cached `STAGES_TTL_MS`) | `error` string in `/-/api/memory/stages` |
| `POST $CONDUCTOR_URL/mcp/tools/list_projects` `{}` (`projects[].{name, workspace: string\|null, degraded?}`) | workspace matching, only when a scope's outcome depends on it (one project → workspace index cached `WORKSPACES_TTL_MS`, never served older; a project missing from it is read again once; deadline `WORKSPACES_TIMEOUT_MS` at Stop and import, the shared `MEMORY_LIMITS.recallDeadlineMs` on recall; concurrent refreshes share one read, aborted only when every waiter has given up); the scope editor's project suggestions (deadline 5 s). `.conduct` is not listed and is in no workspace without asking. A `degraded` row's `workspace: null` means unknown | `WORKSPACE_UNRESOLVED` (also for a project missing from a fresh read or a `degraded` row); `error` string in `/-/api/memory/cc-projects` |
| `POST $CONDUCTOR_URL/mcp/tools/list_workspaces` `{}` (`workspaces[].{name, projectCount}`) | the scope editor's workspace suggestions (not cached) | `error` string in `/-/api/memory/cc-projects` |

## For clients of the Hindsight API

`supervisor.connection()` (`src/supervisor.js`) returns `{apiUrl: http://<bind>:<apiPort>, apiKey}` while ready. Send the key as `Authorization: Bearer <apiKey>`.
