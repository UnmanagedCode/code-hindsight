> See also: [README](../README.md) · [features.md](features.md) · [protocol.md](protocol.md)

# Architecture

```
browser ── cc /plugins/code-hindsight/* ──► backend (node:http, 127.0.0.1:$PORT)
                                              ├─ /, /assets/*      shell UI (frontend/dist)
                                              ├─ /-/api/*          routes.js
                                              └─ everything else   cpProxy.js ──► <bind>:<cpPort>  CP container ─┐
                                                                                                                │ code-hindsight-net
                     supervisor.js ── docker.js ── docker | sudo -n docker ──► <bind>:<apiPort> API container ◄─┘
                                                                               └─ volume code-hindsight-data (.pg0)
```

The Claude Code side is a plugin root, `claude/` (declared by `claudePlugin` in the manifest, so cc passes it to every session as `--plugin-dir`): `hooks/hooks.json`, `hooks/hook.mjs` (the one entry), `hooks/transcript.mjs`, `hooks/limits.mjs`, `skills/memory/SKILL.md`. The recall tool is declared by the manifest's `mcp` and served at `/-/mcp`, so cc attributes the caller from its own per-session URL.

## Modules (`src/`)

| Module | Responsibility |
|---|---|
| `pins.js` | the single source of the Hindsight release, image refs and pinned image IDs, the build helper's digest, CP build inputs, base path, resource prefix, label keys |
| `trust.js` | which images may run: pinned-ID checks, the trusted CP image record (`trusted-cp.json`) |
| `tarStream.js` | streaming tar: append the bundle manifest on export, read it on import |
| `config.js` | env → `{port, dataDir, conductorUrl, pluginId, distDir}` |
| `fsPrivate.js` | 0700 dirs, atomic 0600 files |
| `settings.js` | settings shape, defaults, validation (incl. the slim rule), embeddings fingerprint, store |
| `secrets.js` | generated and user keys in `secrets.json`; `has()` for the UI |
| `netDetect.js` | automatic bind address from `/.dockerenv` and `/proc/net/route` |
| `errors.js` | the error catalog (`CATALOG`), `AppError` |
| `docker.js` | the only module that runs docker: invocation resolution (direct → `sudo -n`), error classification, name and image guards, env files, detached stop, the socket-mounting helper run (pinned IDs only) |
| `llmEnv.js` | LLM env for none / manual / cc-backend; cc backend summary for the picker |
| `containerSpec.js` | pure builders of both containers' run args, env, labels and spec hash; resource names; owner id |
| `supervisor.js` | Hindsight's state machine: start/adopt/recreate, health wait, watch, stop, restart, SIGTERM shutdown |
| `jobs.js` | the user-initiated Docker actions, one at a time, with logs |
| `cpSession.js` | server-side CP sign-in and token renewal |
| `cpProxy.js` | the CP reverse proxy (base path, Location, cookies, re-sign-in, CSRF, not-ready page) |
| `routes.js` | `/-/api/*` |
| `scopes.js` | scope shape and validation, the glob matcher, bank-template rendering, `matchScopes`, the `scopes.json` store |
| `ccSession.js` | read-only cc client: `resolveSession` (`describe_session`) and `fetchStages` |
| `hindsightClient.js` | recall and retain calls over `supervisor.connection()` |
| `retainCursor.js` | `memory/cursors.json`, windows of unsent turns (`windowTurns`, `lastExchangeBoundary`), the deterministic `operation_id` |
| `memory.js` | recall/retain/tool orchestration, the injected-context format, the injected-id set, the per-session retain worker; owns `MEMORY_LIMITS` |
| `activity.js` | the activity ring buffer and `logs/memory.jsonl` |
| `hookRoutes.js` | `/-/hook/*` and `/-/mcp`: request policy, limits, dispatch to `memory.js` |
| `http.js` | security headers, JSON/text replies, the static allowlist |
| `app.js` | builds the collaborators and the one request handler |
| `server.js` (root) | config → app → listen; `ensureRunning()` at listen; SIGTERM/SIGINT → `shutdown()` → exit |

## Lifecycle

- **Health vs Hindsight.** cc counts the backend ready on any HTTP answer from `healthPath` within its readiness deadline, and does not kill a child that misses it. So the backend listens and answers `/-/api/health` at once; Hindsight's state is separate and shown in the UI.
- **Start (`ensureRunning`)**, serialized with stop/restart:
  1. wait for a pending detached stop (`stopping.json`, pid alive and recent);
  2. resolve docker (`DOCKER_*`);
  3. validate the saved settings (`SETTINGS_INVALID`, `SLIM_*`);
  4. check the API image's ID against the pins (`IMAGE_*`), the CP image's base-path/upstream labels (`CP_IMAGE_MISMATCH`) and its ID against `trusted-cp.json` (`CP_IMAGE_UNTRUSTED`) — never pull;
  5. network and volume: create with labels, or verify the owner (`NAME_TAKEN`) and the volume's embeddings fingerprint (`EMBEDDINGS_CHANGED`);
  6. compose the LLM env (cc-backend reads cc now);
  7. API then CP container, run by the verified image ID: missing → `run`; another owner → `NAME_TAKEN`; spec hash or image ID differs → stop, rm, `run` (volume kept); exited → `start`; running and matching → adopt;
  8. wait for API `/health` 200 (detecting an exited container → `CRASHED`, timeout → `UNHEALTHY` with a log tail), then CP `<base path>/api/health`, then sign in to the CP → `ready`.
- **Boot = apply.** Every backend start reconciles to the saved settings, so containers never run a spec the Settings page does not show. `pendingRestart` flags saved-but-not-applied settings while ready.
- **Watch.** While ready, one loop polls API `/health` (each start bumps a token that ends any earlier loop at its next wake, so restarts never stack loops); an exited API or CP container is `CRASHED`, a running API failing several consecutive probes is `UNHEALTHY` (`DEFAULT_TIMEOUTS` in `src/supervisor.js`). Docker's `on-failure` restart policy handles transient crashes first.
- **Stop paths.**
  - *Stop button:* `docker stop` of both, containers and volume kept.
  - *SIGTERM* (cc Stop, Disable, Restart, Update): cc SIGKILLs the process group after a short grace period, too short for Postgres. `shutdown()` spawns `docker stop -t 30 cp api` **detached** (own process group, outlives the backend), writes `stopping.json {pid, at}`, and the process exits. The next backend waits for that pid before reconciling. The stop uses the current docker invocation, else the last one that worked while still allowed (a settings save or a `DOCKER_DENIED` resets the current one; a remembered `sudo` invocation is never reused once sudo is switched off), else plain docker within a resolve bounded well inside the grace period. When the stop cannot start — no invocation resolves (`DOCKER_DENIED` after a sudo opt-out, an unreachable daemon) or the process fails to spawn — `shutdown-failed.json` records why (no pid-less `stopping.json`), and Status shows it until Hindsight is next ready.
  - *cc restart:* cc re-adopts its running backends without signalling them; nothing happens.
  - *SIGKILL of the backend alone:* containers keep running until the next backend start adopts them.
- **No implicit network or destructive operation.** The start path only inspects, creates the network/volume, and runs/starts/stops/removes this plugin's own containers. Pull, build, load, save, rmi and volume rm happen only in jobs, and only precondition jobs (pull, build-cp, import, trust-cp) may start Hindsight afterwards.

## Image trust

- Tags and labels are whatever the last `docker pull`, `load` or `tag` said, so neither decides what runs. An image's `.Id` is content-addressed: the API images and the build helper are pinned by ID in `pins.js`; the CP image, built locally, is trusted on first use (`build-cp` records the ID it built) or by an explicit confirm of a shown ID (`trust-cp`).
- `.Id` is the index digest under the containerd image store and the per-platform config digest under the classic store; the pins list both forms.
- The build helper is the only image given the Docker socket (root on the host): it is resolved by a digest reference, verified by ID, and run by ID (`runHelper` refuses any other).
- Containers run by the verified ID, so a retag between the check and `docker run` cannot swap the image.

## CP embedding

- The CP image is built from the upstream source with `NEXT_PUBLIC_BASE_PATH=/plugins/code-hindsight`, so its pages, assets, API calls, middleware redirects and router navigation all carry the mount path. The backend proxies every non-shell path to it, putting the base path back that cc stripped.
- The shell page frames the CP same-origin (`iframe[data-cp-frame]`, `src` relative to the mount). On each frame load it copies cc's `dark` class onto the CP document, replaces the CP's `history.pushState` with `replaceState`, and reports the CP path into the shell's query (`?view=cp&cp=…`), which the bridge mirrors into cc's URL.
- A CP link to its own root lands the shell inside the frame; the shell detects `frameElement[data-cp-frame]` and sends the frame to `dashboard`.

## Memory

```
Claude session ── hook.mjs ──► $CONDUCTOR_URL/plugins/code-hindsight/-/hook/* ──► hookRoutes ──► memory.js
                                                                                      ├─ ccSession    describe_session (every call)
cc MCP forward ──► /-/mcp (caller.sessionId from cc's per-session URL) ──────────────►├─ scopes       match → banks
                                                                                      ├─ hindsightClient ──► Hindsight API
                                                                                      ├─ retainCursor  memory/cursors.json
                                                                                      └─ activity      logs/memory.jsonl
```

- **The hook stays thin; the backend decides.** The hook sends `CC_SESSION_ID` plus its event data. The backend resolves the session on every call (one `describe_session` carries project, worktree and stage, so nothing is cached and the stage is always current), derives kind from `live.project`, and matches scopes. Retired or unresolved sessions are memoryless.
- **Budgets nest:** the backend's recall budget (`DESCRIBE_TIMEOUT_MS` + `MEMORY_LIMITS.recallTimeoutMs`) is below the hook's deadline (`HOOK_TIMEOUTS`), which is below the `timeout` in `hooks.json`; `tests/manifest.test.mjs` pins the order. A timeout, crash or bad JSON never blocks Claude Code, so the worst case of any failure is a memoryless turn.
- **Retain is a persisted cursor with windows, then an append.** The hook sends a bounded tail of parsed turns, never a path. Each Stop records the turns it adds as one **window** in the session's cursor entry (`memory/cursors.json`, keyed by the public session id so it survives `/clear`, renew and transcript rotation), tagged with the bank that stage's first retain scope chose, or none.
  - **Recording (`record`).** A Stop whose tail is *provably* older than the newest recorded end is ignored (`endsAfter`): Stop hooks are separate processes and can arrive out of order. Provable means the previous end is in the tail and the tail ends at an id at or before it (a repeated id counts), or the tail's newest timestamp (or its end turn's) is earlier than the previous end's. Equal timestamps are accepted; sibling turns of one transcript line share one. With no timestamps and no id overlap nothing can be proven, so ordering is **best effort**, and the drain backs it up. A new window replaces the newest one only when both aim at the same bank (or both at none) *and* the incoming tail still contains the newest window's end; otherwise it stays a separate window, so a loss is reported by the drain instead of being swallowed.
  - **Draining.** One worker per session walks the entry in order, drains once more if a Stop arrived while it ran, and stops at the first failure or when Hindsight is not ready. First the unacknowledged batch (`inflight`, resent unchanged under its `operation_id`); then each window — no bank: the cursor just advances past it; a bank: that window's turns (`windowTurns`: after the previous boundary up to its own end, located by turn id, else by timestamp) are appended to `cc-session:<id>` in that bank. With no cursor the first window is the last exchange only (`lastExchangeBoundary`); history is never backfilled. Windows are placed in the newest tail the worker has seen; a late, provably older tail does not replace it. **The cursor never moves backwards:** a window provably at or behind it (same end; earlier in the tail; else earlier by timestamp) is dropped from the list with the cursor left alone and, if it carried a bank, reported as `RETAIN_STALE` (nothing was lost or sent twice).
  - **Attribution.** Windows are persisted before anything is sent, so a Hindsight that is not ready, a failed retain or a restarted backend cannot re-attribute turns: each stretch goes to the bank its own stage chose, and turns from a stage with no retain scope are never sent.
  - **Timestamp fallback.** When a boundary id is gone (rotation, trim), turns are placed by time: after `from`'s timestamp, up to `to`'s. A turn stamped at exactly `from`'s millisecond counts as the boundary turn itself and is excluded (siblings of one transcript line share a timestamp; re-sending the boundary after every rotation would be worse).
  - **Losses are explicit.** `windowTurns` returns `null`, never an empty list, when a window cannot be placed (recorded windows are never empty); the drain logs `RETAIN_DROPPED` and advances. The windows are also bounded by `MEMORY_LIMITS.retainQueueMax`: on overflow the oldest window with a bank becomes one with none and adjacent bank-less windows merge. Nothing is ever sent to another bank.
  - **Corrupt state.** A cursor entry of the wrong shape (`isValidCursor`) is dropped and logged `CURSOR_INVALID`; the next retain starts from the last exchange, without backfilling. A `cursors.json` that is not valid JSON or not an object is moved aside to `memory/cursors.json.corrupt` (replacing an older one), the store starts fresh, and `CURSOR_INVALID` is logged once.
  - **Known unlogged edges.** Two losses are not reported: a window only *partly* placeable in the tail loses its trimmed prefix without a log entry (only a window with nothing placeable is reported); and a turn stamped in exactly the boundary's millisecond is excluded by the timestamp fallback, so a never-sent sibling sharing that millisecond with a boundary whose id is gone is lost silently.
  - Hindsight serializes appends per document and returns the original operation for a repeated id, so a lost response cannot duplicate.
- **Identity is advisory.** See [README → Trust model](../README.md#trust-model).
- **Failures** are logged by `memory.js` as activity entries with a catalog code; nothing at the hook boundary throws.

## Pins and bumping Hindsight

`src/pins.js` holds the version, the upstream commit (the official images' `org.opencontainers.image.revision`, which the CP is built from), the per-variant image refs, version labels and image IDs, the CP image tag, the build helper (`docker:<version>-cli` by digest with its IDs; it carries buildx and must not be newer than the daemon's API), and the base path. To bump: update those (an image's IDs: `docker image inspect` for the index digest, `docker buildx imagetools inspect --raw` of each platform manifest for the config digests), run **Build CP image** and **Pull** (or import a bundle), then Start: the ID checks refuse any image of another release.

## Tests

| Command | What |
|---|---|
| `npm test` | `test:server` (node:test, `tests/*.test.mjs`), `typecheck` (`tsc -p frontend`), `test:web` (Vitest, `frontend/src/**/*.test.tsx`). Needs no Docker |
| `RUN_REAL_DOCKER=1 npm run test:real` | `tests/*.real.test.mjs` against the real daemon with the locally present pinned images (never pulls) |
| + `CODE_HINDSIGHT_CHROMIUM=<chrome binary>` or `CODE_HINDSIGHT_CDP_URL=<CDP endpoint>` | also runs `tests/cp-basepath.real.test.mjs`, the CP under the base path in a real browser (with `frontend/dist` built, also inside a cc-style frame through the shell's nested frame) |
| `RUN_REAL_CLI=1 node --test tests/hooks-cli.real.test.mjs` | the hook path in a real `claude -p --input-format stream-json` session against a fake backend: the prompt hook fires, its context reaches the model, the async Stop posts the turns (needs the `claude` CLI and its login) |
| + `CODE_HINDSIGHT_TEST_EMBEDDINGS_KEY` (optional `_MODEL`, `_BASE_URL`) | also runs the slim-image test with remote embeddings and the `rrf` reranker |

- **Fakes.** `tests/fakes/fake-docker.mjs` implements the docker subcommands the plugin uses over a JSON state file (images found by ref or ID; `save`/`load` speak real tar holding a `fake-images.json`) and logs every call; `FAKE_DOCKER_MODE` injects `denied`, `daemon-down`, `port-clash`, `crash`, `fail-<subcommand>`. `tests/fakes/fake-sudo.mjs` honours only `-n` (`FAKE_SUDO_MODE=password` refuses). They are wired in through `CODE_HINDSIGHT_DOCKER_BIN` / `CODE_HINDSIGHT_SUDO_BIN`.
- **Isolation.** `tests/helpers.mjs` `mkRoot` gives each test a temp projects root and data dir; `boot` runs `createApp` over the fakes on port 0 with an injected clock and probe. Tests never use the real data dir.
- **No live cc.** `tests/support/ccFront.mjs` reproduces cc's plugin proxy (prefix strip, `X-Forwarded-*`, prefix re-added to every root-relative `Location`, `X-Frame-Options`) for the proxy and browser tests.
- **Memory fakes.** `tests/support/fakeCc.mjs` (programmable `describe_session` per call, `/api/playbooks`, a call log) and `tests/support/fakeHindsight.mjs` (Bearer-checked recall and retain over in-memory banks: per-bank latency, status switches, 404 for an uncreated bank, repeated `operation_id` ignored, in-flight tracking). `tests/support/runHook.mjs` runs the real `hook.mjs` as a process.
- **Live check.** With `CODE_HINDSIGHT_LIVE_CC=$CONDUCTOR_URL` and `CODE_HINDSIGHT_LIVE_SESSION=<a live session id>`, `tests/memory.real.test.mjs` also boots a scratch backend on a temp data dir and random ports (so the enabled plugin's containers and data are never touched), points its cc at the live one for the read-only `describe_session` and `/api/playbooks` only, writes a scope matching that session's real project, kind and stage, and drives the real hook for recall, retain and recall; a scope for another stage must leave the session memoryless. With `RUN_REAL_CLI=1` it also runs a real `claude -p --plugin-dir claude` against that backend.
- **Real stacks** (`tests/support/realStack.mjs`) use a random `code-hindsight-test-<hex>` prefix and random host ports, trust the local CP image through the `trust-cp` job, and remove their containers, network and volume afterwards, even on failure.
- **Guards.** `tests/supervisor.test.mjs` checks over a full lifecycle that every docker call names only prefixed resources and none connects a network; `tests/frontend-source.test.mjs` scans the UI for HTML sinks, root-relative URLs and the head order.
