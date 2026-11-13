# code-hindsight

A code-conductor (cc) plugin that runs [Hindsight](https://hindsight.vectorize.io), an agent memory server, in Docker on the cc host and shows Hindsight's control-plane UI inside cc at `/plugins/code-hindsight/`.

It manages two containers (the Hindsight API with its embedded Postgres, and a control plane built for cc's mount path), keeps memories in a named Docker volume, works offline from exported image bundles, and reports every failure by name with the action that fixes it. It also gives cc sessions memory: Claude Code hooks recall from and retain into Hindsight banks chosen by user-configured scopes. Memory is off until a scope exists.

## Quick start

1. In cc: **Settings → Plugins → Rescan**, enable **Code Hindsight**, open it from the app switcher.
2. **Images & data:** **Pull full image** (or import a bundle), then **Build CP image** once (needs network). An imported control-plane image runs only after you confirm its ID there (a guard against running an unexpected image by accident; see [Trust model](#trust-model)).
3. **Status → Start Hindsight**, then the **Control plane** tab.
4. **Memory** tab → **Add scope** and Save to switch memory on (it is off with no scopes). Sessions started afterwards use it.
5. Switch on **Auto-start** for the plugin (Settings → Plugins) to have Hindsight up after every cc start: Hindsight runs only while the plugin's backend runs.

Install hook for a Library entry: `npm install` (it builds `frontend/dist` through `prepare`).

## Key defaults

- Image variant **full** (local embeddings and reranker, works offline); **slim** needs remote embeddings and the `rrf` reranker.
- LLM **none**: memories are stored as chunks; reflect and observations need an LLM (manual, or linked to one of cc's Anthropic-compatible backends).
- Ports: fixed, configurable (`DEFAULT_SETTINGS` in `src/settings.js`); bind address automatic: the default gateway when cc runs in a container, else `127.0.0.1`.
- `sudo -n docker` is used when docker is refused, unless switched off in Settings.
- Nothing is pulled, built, imported or deleted without a button press.

## Trust model

- **`sudo docker` is root on the host.** With sudo allowed, this plugin drives the Docker daemon as root. It only ever names `code-hindsight-*` containers, volumes and networks and the pinned images, and refuses a same-named resource another cc created.
- **Images are trusted by ID, not by tag or label.** The official API images and the build helper (the one image given the Docker socket) must have a pinned image ID (`src/pins.js`); the control-plane image must have the ID this plugin built or the user confirmed. Containers run by that ID. The confirmation guards against running an unexpected control-plane image by accident (a wrong tarball, a stale import); it is **not** a barrier against a caller that can reach the plugin API, which publishes the ID it asks for and can import and confirm an image itself — see the next bullet.
- **The plugin's own API (`/-/api/*`) is unauthenticated**, like cc's: any local process, or any script running on cc's origin, can drive it — and could already drive cc itself, which can do more. State-changing requests and every control-plane request must carry browser fetch metadata from this origin (`Sec-Fetch-Site: same-origin` or `none`), so other websites cannot.
- **The control plane runs same-origin with cc** and renders memories that agents wrote. A script injected into it would have cc's full (unauthenticated) API.
- **Both published ports need a key** (the API key; the CP access key, used server-side). Other containers on the Docker host can reach the bind address. Hindsight leaves `/health*`, `/version`, `/metrics`, `/docs`, `/openapi.json` (API) and its login/health/version routes (CP) open; none returns memory data.
- **Session identity for memory is advisory, and scopes are not an isolation boundary.** The backend trusts the session id a hook or the recall tool claims (it must be a live cc session) and an agent can claim another live session's id. Every session also runs as the same OS user as the backend, so an agent with a shell can read `secrets.json` and query Hindsight directly. Scopes keep cooperating agents' memory in its lane; they do not contain an adversarial one.
- **Retained content is not redacted.** Prompts, replies and tool-call targets (a command line, a path) that contain secrets reach Hindsight and, with an LLM configured, its provider.
- **Recalled memory is other sessions' text.** It is wrapped and labelled as data, but a memory that tries to instruct the agent remains a risk.
- **Every prompt is also sent to Hindsight (and, with an LLM configured, its provider) as a recall query** whenever a recall scope matches the session, whether or not the turn is retained.
- **The hook and tool routes** (`/-/hook/*`, `/-/mcp`) refuse requests that look like a browser's, so a web page cannot read memories or inject retains through them.
- Keys live in `secrets.json` (0600) in the plugin data dir and are never returned by any route. A key is cleared when its provider or URL changes without it being entered again.

## Known limitations

- Hooks, the skill and the recall tool are fixed into a session when cc spawns it: enabling the plugin reaches only sessions started afterwards.
- A stopped or crashed backend cannot log its own absence: hooks give up silently (a memoryless turn) and only cc's plugin row shows it.
- The recall tool is text-only (no JSON format).
- Bank names are sanitized, so different projects can map to the same bank.
- If `memory/cursors.json` is lost, turns already retained can be retained again.
- `memory/cursors.json` is one file, rewritten synchronously on each Stop and each drain step, and it holds each session's unacknowledged batch. Hundreds of sessions blocked at once on large batches make it large, and writing it can slow concurrent recalls.
- With LLM mode `none`, retain stores raw chunks without fact extraction.
- If Hindsight stays unavailable long enough that a session's backlog of unsent turns overflows, or the turns leave the transcript tail the hook sends, they are dropped (logged as `RETAIN_DROPPED`), never sent to another bank.
- Inside the control plane, attachment links and images, the logo in the memory constellation and the favicon 404 (upstream builds those URLs without the base path).
- The control plane is only usable through cc's mount (`/plugins/code-hindsight/`); its port alone has no UI session.
- Hindsight runs only while the plugin backend runs (see Auto-start). A backend killed with SIGKILL alone leaves the containers running until the next start adopts them.
- The cc-backend LLM link reads cc's internal `GET /api/settings/models`; a change to that route is reported as `CC_ROUTE_CHANGED`. Linked tokens are sent as Anthropic `x-api-key`; endpoints that accept only a bearer token refuse them. Loopback backends cannot be linked (best-effort: literal addresses and `localhost`; host names are not resolved).
- The control plane needs a browser that sends fetch metadata (current Chrome, Edge, Firefox, Safari ≥ 16.4); requests without it are refused.
- Changing embeddings on existing memories is refused; deleting the data volume is the way out.
- One instance per Docker daemon: container, volume and network names are daemon-global, so a second cc on the same daemon is refused `NAME_TAKEN`.

## Docs

- [docs/features.md](docs/features.md) — the UI: tabs, settings, actions, the offline workflow, error codes.
- [docs/protocol.md](docs/protocol.md) — routes, the error shape, data-dir files, Docker resource names and labels, container env, the CP proxy rules, the cc routes read.
- [docs/architecture.md](docs/architecture.md) — modules, lifecycle and state machine, CP embedding, pins and bumping Hindsight, tests.

## Technical summary

- Stack: Node ≥ 22.12, plain ESM backend on `node:http` (no runtime dependencies); React + Vite + TypeScript + Tailwind v4 UI built into `frontend/dist`; node:test and Vitest.
- Run standalone: `CONDUCTOR_PLUGIN_DATA_DIR=/abs/dir PORT=4747 npm start` (the UI expects cc's mount for the control plane).
- Test: `npm test` (no Docker needed); `RUN_REAL_DOCKER=1 npm run test:real` against the real daemon.

## Layout

```
conductor.plugin.json     cc manifest
server.js                 entry point
src/                      backend modules (docs/architecture.md)
claude/                   Claude Code plugin root: hooks, transcript reader, memory skill
frontend/                 the shell UI (React + Vite)
tests/                    node:test suites, fakes/, support/, *.real.test.mjs (gated)
docs/                     features, protocol, architecture
.code-conductor/post-worktree-create.sh   links the project wiki into new worktrees
```
