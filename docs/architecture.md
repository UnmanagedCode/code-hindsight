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
  - *SIGTERM* (cc Stop, Disable, Restart, Update): cc SIGKILLs the process group after a short grace period, too short for Postgres. `shutdown()` spawns `docker stop -t 30 cp api` **detached** (own process group, outlives the backend), writes `stopping.json {pid, at}`, and the process exits. The next backend waits for that pid before reconciling. The stop uses the current docker invocation, else the last one that worked (a settings save or a `DOCKER_DENIED` resets the current one), else a resolve bounded well inside the grace period. When the stop cannot start, `shutdown-failed.json` records why (no pid-less `stopping.json`), and Status shows it until Hindsight is next ready.
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

## Pins and bumping Hindsight

`src/pins.js` holds the version, the upstream commit (the official images' `org.opencontainers.image.revision`, which the CP is built from), the per-variant image refs, version labels and image IDs, the CP image tag, the build helper (`docker:<version>-cli` by digest with its IDs; it carries buildx and must not be newer than the daemon's API), and the base path. To bump: update those (an image's IDs: `docker image inspect` for the index digest, `docker buildx imagetools inspect --raw` of each platform manifest for the config digests), run **Build CP image** and **Pull** (or import a bundle), then Start: the ID checks refuse any image of another release.

## Tests

| Command | What |
|---|---|
| `npm test` | `test:server` (node:test, `tests/*.test.mjs`), `typecheck` (`tsc -p frontend`), `test:web` (Vitest, `frontend/src/**/*.test.tsx`). Needs no Docker |
| `RUN_REAL_DOCKER=1 npm run test:real` | `tests/*.real.test.mjs` against the real daemon with the locally present pinned images (never pulls) |
| + `CODE_HINDSIGHT_CHROMIUM=<chrome binary>` or `CODE_HINDSIGHT_CDP_URL=<CDP endpoint>` | also runs `tests/cp-basepath.real.test.mjs`, the CP under the base path in a real browser (with `frontend/dist` built, also inside a cc-style frame through the shell's nested frame) |
| + `CODE_HINDSIGHT_TEST_EMBEDDINGS_KEY` (optional `_MODEL`, `_BASE_URL`) | also runs the slim-image test with remote embeddings and the `rrf` reranker |

- **Fakes.** `tests/fakes/fake-docker.mjs` implements the docker subcommands the plugin uses over a JSON state file (images found by ref or ID; `save`/`load` speak real tar holding a `fake-images.json`) and logs every call; `FAKE_DOCKER_MODE` injects `denied`, `daemon-down`, `port-clash`, `crash`, `fail-<subcommand>`. `tests/fakes/fake-sudo.mjs` honours only `-n` (`FAKE_SUDO_MODE=password` refuses). They are wired in through `CODE_HINDSIGHT_DOCKER_BIN` / `CODE_HINDSIGHT_SUDO_BIN`.
- **Isolation.** `tests/helpers.mjs` `mkRoot` gives each test a temp projects root and data dir; `boot` runs `createApp` over the fakes on port 0 with an injected clock and probe. Tests never use the real data dir.
- **No live cc.** `tests/support/ccFront.mjs` reproduces cc's plugin proxy (prefix strip, `X-Forwarded-*`, prefix re-added to every root-relative `Location`, `X-Frame-Options`) for the proxy and browser tests.
- **Real stacks** (`tests/support/realStack.mjs`) use a random `code-hindsight-test-<hex>` prefix and random host ports, trust the local CP image through the `trust-cp` job, and remove their containers, network and volume afterwards, even on failure.
- **Guards.** `tests/supervisor.test.mjs` checks over a full lifecycle that every docker call names only prefixed resources and none connects a network; `tests/frontend-source.test.mjs` scans the UI for HTML sinks, root-relative URLs and the head order.
