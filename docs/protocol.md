> See also: [README](../README.md) · [features.md](features.md) · [architecture.md](architecture.md)

# Interfaces

## Paths the backend serves

cc strips `/plugins/code-hindsight` before a request reaches the backend.

| Path | Owner |
|---|---|
| `/`, `/index.html`, `/theme-init.js`, `/assets/*` | the shell UI from `frontend/dist` (allowlist in `src/http.js`); unbuilt: HTML entries answer `503` text, others fall through |
| `/pluginBridge.js`, `/pluginTheme.css` | `404` (cc serves them at its own root) |
| `/-/api/*` | the plugin's JSON API (below) |
| `/-/*` (anything else) | `404` |
| every other path | the Hindsight control plane, proxied ([CP proxy](#cp-proxy)) |

Every response the backend itself produces carries `CSP` (`src/http.js`) and `X-Content-Type-Options: nosniff`; proxied CP responses pass through untouched.

## `/-/api/*`

State-changing requests (`POST`, `PUT`) need `Content-Type: application/json` (else `415 UNSUPPORTED_MEDIA_TYPE`), except the upload import (`application/octet-stream`). All of them are refused `403 CROSS_SITE` when `Sec-Fetch-Site` is present and not `same-origin`/`none`, or when it is absent and `Origin` is present.

| Method | Path | Body → answer |
|---|---|---|
| GET | `/-/api/health` | `{ok: true}` — always 200, whatever Hindsight's state (the manifest's `healthPath`) |
| GET | `/-/api/status[?refresh=1]` | `{state, error, docker: {mode, serverVersion}, variant, bindAddress, bindAuto, ports: {api, cp}, images: {api, cp} \| null, containers: {api, cp} \| null, startedAt, pendingRestart, volume, llmMode, autoStart?, job, bundles: [{name, size}], bundleNames: {full, slim}}`. `refresh=1` re-inspects images and containers first. `autoStart` is cc's flag for this plugin, omitted when cc cannot be asked |
| GET | `/-/api/settings` | `{settings, secrets: {llmApiKey: bool, embeddingsApiKey: bool}, defaults, detectedBindAddress, choices, images}` |
| PUT | `/-/api/settings` | `{settings, secrets?: {llmApiKey?, embeddingsApiKey?}}` — the whole settings object; a secret string sets, `null`/`""` clears, absent keeps. `400 SETTINGS_INVALID` with `params.fields: [{field, code?, message}]`. Answers the settings view plus `status` |
| GET | `/-/api/cc-backends` | `{backends: [{id, label, host, usable, refusal, models: [{model, label}]}]}` — never a token |
| POST | `/-/api/start` | start / reconcile to the saved settings; answers status at once |
| POST | `/-/api/restart` | stop, then start; answers status at once |
| POST | `/-/api/stop` | stop the containers (kept); answers status when stopped |
| POST | `/-/api/jobs/<kind>` | start a job (below); answers the job (`state: "running"`); `409 BUSY` while another runs |
| POST | `/-/api/jobs/import` (`application/octet-stream`) | the body is streamed into `docker load`; answers the finished job |
| GET | `/-/api/jobs` | `{jobs: [...]}` (most recent first, no tails) |
| GET | `/-/api/jobs/<id>` | `{id, kind, state: running\|done\|failed, startedAt, endedAt, result, error, tail}` |
| GET | `/-/api/logs/<api\|cp>` | `{role, log}` — last 200 lines of the container's log |
| GET | `/-/api/bundles/<name>` | the bundle file (`application/x-tar`, attachment); only names the plugin wrote into its bundle dir |

**Errors** answer the catalog entry `{code, title, message, action, params}` with the entry's HTTP status (`CATALOG` in `src/errors.js`). The same shape is `status.error` and `job.error`.

### Jobs

| `<kind>` | Body | Result |
|---|---|---|
| `pull` | `{variant: "full"\|"slim"}` | `{image}` |
| `build-cp` | `{}` | `{image}` |
| `import` | `{path: "/abs/file.tar"}` (or the octet-stream upload) | `{loaded: [refs]}` |
| `export` | `{variant}` | `{name, path, size, sha256}` |
| `remove-images` | `{confirm: true}` | `{removed: [refs]}` |
| `delete-volume` | `{confirm: "<volume name>"}` | `{removed}` |

`remove-images` and `delete-volume` refuse `CONFIRMATION_REQUIRED` without their confirmation and fail `CONTAINERS_RUNNING` while a container of this plugin runs.

## Hindsight states

`stopped → checking → starting → ready`, plus `stopping` and `error` (with `error` set). `ready` means the API answered `/health` with 200, the CP answered `<base path>/api/health`, and the backend signed in to the CP.

## Data dir (`$CONDUCTOR_PLUGIN_DATA_DIR`, mode 0700)

| File | Content |
|---|---|
| `settings.json` (0600) | the settings; never a key |
| `secrets.json` (0600) | `apiKey`, `cpAccessKey` (generated once), `llmApiKey`, `embeddingsApiKey` |
| `stopping.json` (0600) | `{pid, at}` of the detached `docker stop` a SIGTERM left running; the next backend waits for that pid |
| `run/` | short-lived `--env-file`s for `docker run`, removed after each run |
| `logs/jobs/<id>.log` | each job's output |
| `bundles/code-hindsight-<version>-<variant>.tar` (0600) | exported bundles |

## Docker resources

All names derive from `RESOURCE_PREFIX` (`src/pins.js`) through `resourceNames` (`src/containerSpec.js`): `<prefix>-api`, `<prefix>-cp`, `<prefix>-net`, `<prefix>-data`, `<prefix>-build` (the CP build helper). The plugin never touches a container, volume or network outside the prefix, and never connects anything to a network.

Labels (`LABELS` in `src/pins.js`):

| Label | On | Value |
|---|---|---|
| `io.code-hindsight.managed` | containers, network, volume | `1` |
| `io.code-hindsight.owner` | containers, network, volume | `ownerId(dataDir)`: a resource with our name and another owner is refused `NAME_TAKEN` |
| `io.code-hindsight.role` | containers | `api` / `cp` |
| `io.code-hindsight.spec` | containers | hash of image ID, run arguments and env; a mismatch recreates the container |
| `io.code-hindsight.embeddings` | volume | `local` or `<provider>:<model>`; a mismatch with the settings is `EMBEDDINGS_CHANGED` |
| `io.code-hindsight.basePath`, `io.code-hindsight.upstream` | CP image | the base path and upstream tag it was built with; checked before start (`CP_IMAGE_MISMATCH`) |

### Container environment (`apiSpec` / `cpSpec` in `src/containerSpec.js`)

- **API** (`<prefix>-api`, alias `api` on `<prefix>-net`, `-p <bind>:<apiPort>:8888`, volume at `/home/hindsight/.pg0`, `--restart on-failure:3`): `HINDSIGHT_ENABLE_CP=false`, `HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension`, `HINDSIGHT_API_TENANT_API_KEY`; full image: `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; LLM: `HINDSIGHT_API_LLM_PROVIDER` (`none` by default), `_MODEL`, `_BASE_URL`, `_API_KEY`; `HINDSIGHT_API_EMBEDDINGS_PROVIDER` (+ `_OPENAI_MODEL`, `_OPENAI_BASE_URL`, `_OPENAI_API_KEY`), `HINDSIGHT_API_RERANKER_PROVIDER`.
- **CP** (`<prefix>-cp`, on `<prefix>-net`, `-p <bind>:<cpPort>:9999`, `--restart on-failure:3`): `HINDSIGHT_CP_DATAPLANE_API_URL=http://api:8888`, `HINDSIGHT_CP_DATAPLANE_API_KEY`, `HINDSIGHT_CP_ACCESS_KEY`.
- Env reaches `docker run` through a 0600 `--env-file`, never the command line.
- **Cc-backend mapping:** `HINDSIGHT_API_LLM_PROVIDER=anthropic`, `_BASE_URL=` the row's `ANTHROPIC_BASE_URL`, `_API_KEY=` its `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, `_MODEL=` the chosen model. The token is sent as Anthropic's `x-api-key`.

### Unauthenticated paths

Both published ports need a key except: API `/health*`, `/version`, `/metrics`, `/docs`, `/openapi.json`; CP `<base path>/login`, `/api/auth/*`, `/api/health`, `/api/version` and static assets. None returns memory data.

## CP proxy

`src/cpProxy.js`, for every path not listed in [Paths](#paths-the-backend-serves):

- **Upstream path:** `<BASE_PATH><path>?<query>` on `http://<bind>:<cpPort>`; `Host` is the upstream; `X-Forwarded-*`, `Forwarded` and `X-Real-IP` are dropped.
- **Location:** a root-relative `Location` under `BASE_PATH`, or an absolute one on the upstream origin, is returned root-relative without `BASE_PATH` — cc adds `/plugins/<id>` to every root-relative `Location` (even one that already carries it). Others pass unchanged.
- **Cookies:** the browser's `hindsight_cp_access` is dropped and the backend's session is added; a `Set-Cookie` for `hindsight_cp_access` is removed; other CP cookies get `Path=<BASE_PATH>`.
- **Session:** the backend signs in with `POST <BASE_PATH>/api/auth/login {key}` and renews before the CP's 24 h expiry. A `401` carrying `x-hindsight-session-required`, or a redirect to `/login`, signs in again; `GET`/`HEAD` are retried once, other methods pass the `401` through.
- **Local answers:** `/api/auth/logout` → `200 {success: true}`; `/login?returnTo=<app path>` → `302` to that path (else `/dashboard`).
- **CSRF:** non-`GET`/`HEAD`/`OPTIONS` requests get the same cross-site refusal as `/-/api/*`, before credentials are added.
- **Not ready:** while Hindsight is not `ready`, `503` HTML naming the current error (text-escaped).
- Bodies stream both ways; an aborted client aborts the upstream request; connect timeout 10 s, no total timeout.

## cc routes the backend reads

| Route | Used for | On failure |
|---|---|---|
| `GET $CONDUCTOR_URL/api/settings/models` (`backends[].{id,label,env:[{key,value}]}`, `backendModels`) | the cc-backend link and its picker | `CC_UNREACHABLE` / `CC_ROUTE_CHANGED` |
| `GET $CONDUCTOR_URL/api/plugins/code-hindsight/status` (`autoStart`) | the Auto-start hint | hint omitted |

## For clients of the Hindsight API

`supervisor.connection()` (`src/supervisor.js`) returns `{apiUrl: http://<bind>:<apiPort>, apiKey}` while ready. Send the key as `Authorization: Bearer <apiKey>`.
