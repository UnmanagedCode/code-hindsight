# code-hindsight

A code-conductor (cc) plugin that runs [Hindsight](https://hindsight.vectorize.io), an agent memory server, in Docker on the cc host and shows Hindsight's control-plane UI inside cc at `/plugins/code-hindsight/`.

It manages two containers (the Hindsight API with its embedded Postgres, and a control plane built for cc's mount path), keeps memories in a named Docker volume, works offline from exported image bundles, and reports every failure by name with the action that fixes it. It also gives cc sessions memory: Claude Code hooks recall from and retain into Hindsight banks chosen by user-configured scopes, and past sessions' saved transcripts can be imported on request (Memory → Import past sessions). Memory is off until a scope exists.

## Quick start

1. In cc: **Settings → Plugins → Rescan**, enable **Code Hindsight**, open it from the app switcher.
2. **Images & data:** **Pull full image** (or import a bundle), then **Build CP image** once (needs network). Images are pinned by tag; see [Trust model](#trust-model).
3. **Status → Start Hindsight**, then the **Control plane** tab.
4. **Memory** tab → **Add scope** and Save to switch memory on (it is off with no scopes). Sessions started afterwards use it.
5. Switch on **Auto-start** for the plugin (Settings → Plugins) to have Hindsight up after every cc start: Hindsight runs only while the plugin's backend runs.

Install hook for a Library entry: `npm install` (it builds `frontend/dist` through `prepare`).

## Key defaults

- Image variant **full** (local embeddings and reranker, works offline); **slim** needs remote embeddings and the `rrf` reranker.
- Compute **CPU**. **GPU** runs the local embedding and reranker models on the host's NVIDIA GPUs: it needs the NVIDIA driver and Container Toolkit on the Docker host and a GPU image built locally once (**Images & data → Build GPU image**), and is ready only once both models report `cuda` ([docs/features.md → GPU compute](docs/features.md#gpu-compute)).
- LLM **none**: memories are stored as chunks; reflect and observations need an LLM (manual, or linked to one of cc's backends: Anthropic-compatible, including endpoints on cc's own loopback, or cc's Ollama daemon, both through a relay container).
- Ports: fixed, configurable (`DEFAULT_SETTINGS` in `src/settings.js`); bind address automatic: the default gateway when cc runs in a container, else `127.0.0.1`.
- `sudo -n docker` is used when docker is refused, unless switched off in Settings.
- Nothing is pulled, built, imported or deleted without a button press.

## Trust model

- **`sudo docker` is root on the host.** With sudo allowed, this plugin drives the Docker daemon as root. It only ever names `code-hindsight-*` containers, volumes and networks and the pinned image tags, and refuses a same-named resource another cc created.
- **Images are pinned by tag, never by digest** (`src/pins.js`). The API image runs when its pinned tag is present. The control-plane image runs when `CP_IMAGE` is present and carries this plugin's base-path and upstream labels. The GPU image (Compute GPU) runs when `API_GPU_IMAGE` is present and carries this plugin's upstream and CUDA-flavour labels; it is built from upstream's CUDA recipe at `UPSTREAM_REVISION` on the pinned full image, plus PyTorch and NVIDIA's CUDA libraries at the fixed torch version from `download.pytorch.org` (and the PyPI indexes they resolve through). The build helper (the one image given the Docker socket) is the pinned `BUILD_HELPER` tag, and the only image `runHelper` accepts. Containers run by the image ID the tag resolves to at start. Whatever an import or a `docker pull`/`tag` puts under those tags is what runs.
- **The plugin's own API (`/-/api/*`) is unauthenticated**, like cc's: any local process, or any script running on cc's origin, can drive it — and could already drive cc itself, which can do more. State-changing requests and every control-plane request must carry browser fetch metadata from this origin (`Sec-Fetch-Site: same-origin` or `none`), so other websites cannot.
- **The control plane runs same-origin with cc** and renders memories that agents wrote. A script injected into it would have cc's full (unauthenticated) API.
- **Every published port needs a key**: the API and control-plane ports (the API key; the CP access key, used server-side) and, while a backend is linked through the relay, the relay's tunnel port (the relay key). Other containers on the Docker host can reach the bind address. Hindsight leaves `/health*`, `/version`, `/metrics`, `/docs`, `/openapi.json` (API) and its login/health/version routes (CP) open; none returns memory data.
- **Session identity for memory is advisory, and scopes are not an isolation boundary.** The backend trusts the session id a hook or the recall tool claims (it must be a live cc session) and an agent can claim another live session's id. Every session also runs as the same OS user as the backend, so an agent with a shell can read `secrets.json` and query Hindsight directly. Scopes keep cooperating agents' memory in its lane; they do not contain an adversarial one.
- **The relay.** The API container cannot reach cc's container, and cc's Ollama daemon and loopback backends listen only on that container's loopback. A relay container on the plugin network (`<prefix>-relay`, aliased for its one active target) takes the API's calls; the plugin dials out to the relay's one published port (the bind address and `network.relayPort`) and answers each call itself. The API-facing port is not published, but containers on the plugin network and host processes can reach it, so every call must carry the generated relay key (`relayKey` in `secrets.json`; the API sends it as its LLM API key) and only the allowlisted paths are forwarded (`RELAY_TARGETS` in `src/pins.js`): model management and token counting are unreachable. For a loopback cc backend the plugin swaps the relay key for the backend's own token, which is held only in plugin memory (never in a container env, `docker inspect`, a route or a log). The tunnel port needs the same key, and a holder of it could pose as the plugin: it would receive **and answer** the API's LLM calls. The plugin in turn sends the key to whatever answers on the tunnel port, so a process that squats on `network.relayPort` while the relay container is down gets it. The key is in both containers' env, visible to `docker inspect` (root), like the API key.
- **Retained content is not redacted.** Prompts, replies and tool-call targets (a command line, a path) that contain secrets reach Hindsight and, with an LLM configured, its provider. With a cc Ollama **cloud** model, that text goes through cc's Ollama daemon to ollama.com under its signed-in account; with a loopback cc backend, it goes wherever that local router sends it, possibly a cloud provider under its own account.
- **Recalled memory is other sessions' text.** It is wrapped and labelled as data, but a memory that tries to instruct the agent remains a risk.
- **Every prompt is also sent to Hindsight (and, with an LLM configured, its provider) as a recall query** whenever a recall scope matches the session, whether or not the turn is retained.
- **The hook and tool routes** (`/-/hook/*`, `/-/mcp`) refuse requests that look like a browser's, so a web page cannot read memories or inject retains through them.
- Keys live in `secrets.json` (0600) in the plugin data dir and are never returned by any route. A key is cleared when its provider or URL changes without it being entered again.

## Known limitations

- Hooks, the skill and the recall tool are fixed into a session when cc spawns it: enabling the plugin reaches only sessions started afterwards.
- A stopped or crashed backend cannot log its own absence: hooks give up silently (a memoryless turn) and only cc's plugin row shows it.
- The recall tool is text-only (no JSON format).
- Bank names are sanitized, so different projects can map to the same bank.
- A slow Hindsight or a slow cc lookup (`describe_session`, `list_projects`) delays every prompt of a session with a recall scope, up to `HOOK_TIMEOUTS.recall` (`claude/hooks/limits.mjs`), the bound for the whole recall. Recall time is dominated by Hindsight's reranker and grows under load, for example while an import's retains are extracting.
- Workspace scopes (`match.workspaces`) see a project moved into or out of a cc workspace only within `WORKSPACES_TTL_MS` (`src/ccSession.js`). They depend on cc's `list_projects`, which runs git per project: a cc slower than its deadline (`WORKSPACES_TIMEOUT_MS` at Stop and import, `MEMORY_LIMITS.recallDeadlineMs` on recall) leaves scopes that depend on the workspace unapplied for that call, logged `WORKSPACE_UNRESOLVED`.
- If `memory/cursors.json` is lost, turns already retained can be retained again.
- `memory/cursors.json` is one file, rewritten synchronously on each Stop and each drain step, and it holds each session's unacknowledged batch. Hundreds of sessions blocked at once on large batches make it large, and writing it can slow concurrent recalls.
- With LLM mode `none`, retain stores raw chunks without fact extraction.
- Import past sessions: a backfilled session goes wholly to the bank its **last recorded stage** selects; a running session is imported only after it ends; sessions of projects cc no longer has registered are unplaceable (reported, never imported). The first scan asks cc about every transcript and can take many minutes (later scans reuse cached placements). With an LLM configured, an import's extraction queues in Hindsight ahead of later live retains. The token estimate is rough. A session's live memory is found only in banks its current retain scopes render: after a scope is renamed or removed, a live document in the old bank is not seen, so the import can repeat turns it holds. Imported turns are sent verbatim (no secret redaction) and, with an LLM configured, reach its provider. With a bank's `store_document_text` off, or Hindsight's sensitive-data redaction on, imported parts never match their stored text: they show as outdated and the session never reads as imported (nothing is extracted twice).
- If Hindsight stays unavailable long enough that a session's backlog of unsent turns overflows, or the turns leave the transcript tail the hook sends, they are dropped (logged as `RETAIN_DROPPED`), never sent to another bank.
- Inside the control plane, attachment links and images, the logo in the memory constellation and the favicon 404 (upstream builds those URLs without the base path).
- The control plane is only usable through cc's mount (`/plugins/code-hindsight/`); its port alone has no UI session.
- The Ollama link needs the daemon reachable from the plugin backend at `OLLAMA_HOST` (default `http://127.0.0.1:11434`). A daemon outage fails the API's LLM calls, not the start; Status shows it. The relay does not restrict which model a request names.
- Hindsight runs only while the plugin backend runs (see Auto-start). A backend killed with SIGKILL alone leaves the containers running until the next start adopts them.
- The cc-backend LLM link reads cc's internal `GET /api/settings/models`; a change to that route is reported as `CC_ROUTE_CHANGED`. Tokens of directly linked (non-loopback) backends are sent as Anthropic `x-api-key`; endpoints that accept only a bearer token refuse them. Loopback detection is best-effort (literal addresses and `localhost`; host names are not resolved, so a name that resolves to loopback is linked directly and fails in the container), and loopback over `https` is refused. A loopback backend's outage fails the API's LLM calls, not the start; Status shows it.
- The control plane needs a browser that sends fetch metadata (current Chrome, Edge, Firefox, Safari ≥ 16.4); requests without it are refused.
- Changing embeddings on existing memories is refused; deleting the data volume is the way out.
- GPU compute: NVIDIA only (no AMD/ROCm, Intel or Apple GPUs); every GPU is passed in (`--gpus all`), with no picker; the host driver must support CUDA 12.9 (`GPU_TORCH_FLAVOR` in `src/pins.js`); verified on x86_64 only. The GPU image takes several extra GB of disk, is built on the host that runs it (needs network), and is not part of offline bundles. Only the embedding model and the reranker move to the GPU: the rest of the API and Postgres stay on the CPU.
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
