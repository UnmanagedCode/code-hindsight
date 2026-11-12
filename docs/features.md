> See also: [README](../README.md) · [protocol.md](protocol.md) · [architecture.md](architecture.md)

# Features

The plugin page is mounted at `/plugins/code-hindsight/` in cc. Its header shows **Code Hindsight**, a status pill (Hindsight's state, plus `sudo docker` when docker runs through sudo) and four tabs. The tab and the control-plane path live in the query string (`?view=cp|status|settings|images&cp=<path>`), so a reload or a cc deep link (`http://cc.internal/#plugin/code-hindsight/?view=status`) lands on the same view.

The page opens on **Control plane** when Hindsight is ready, otherwise on **Status**.

## Control plane

- Hindsight's own control-plane UI, in a frame inside the page, signed in for you: you never type its access key.
- Follows cc's light/dark theme live.
- Navigating inside it adds no browser history entry, so Back leaves the plugin. The CP's path is mirrored into the page URL (`?view=cp&cp=/banks/<id>`).
- While Hindsight is not ready the tab shows the current error and its action instead of the frame.
- Signing out in the CP does nothing (the backend owns the session); the CP's login page sends you back to where you were.

## Status

| Item | Shows |
|---|---|
| Error card | the error's title, message, code and one action button (see [Errors](#errors)) |
| Auto-start hint | when cc reports Auto-start off for this plugin: Hindsight runs only while the plugin backend runs; switch on **Settings → Plugins → Code Hindsight → Auto-start** to have it up after every cc start |
| Settings changed | when the saved settings differ from the running containers: **Apply & restart** |
| Hindsight | state, docker invocation (`docker` or `sudo -n docker`) and daemon version, image variant, bind address and both host ports, LLM mode, ready-since time; **Start / Restart / Stop Hindsight** |
| Images and containers | the pinned API image and the CP image (present / missing / wrong release), both containers' states, **API log** / **CP log** (last 200 lines) |
| Job | the running or last Docker action with its log tail |

**Stop Hindsight** stops both containers and keeps them and the data volume. **Restart Hindsight** stops and starts them again (recreating any whose settings changed).

## Settings

Saved with **Save**; **Apply & restart** saves and reconciles the containers to the new settings. Every refusal is shown on its field.

| Setting | Default | Notes |
|---|---|---|
| Image | `full` | `slim` has no local models: refused (`SLIM_NEEDS_REMOTE_EMBEDDINGS`, `SLIM_NEEDS_RERANKER`) until embeddings are remote with a key or base URL and the reranker is `rrf` |
| Use `sudo -n docker` when docker is refused | on | sudo docker is root on the host |
| Bind address | automatic | the Docker host's address both ports are published on; automatic = the container's default gateway when cc runs in a container, else `127.0.0.1` |
| API port / Control-plane port | `DEFAULT_SETTINGS` in `src/settings.js` | fixed so clients keep a stable URL; a clash is `PORT_IN_USE`, never a silent re-pick |
| LLM mode | None | **None**: memories are stored as chunks; reflect and observations are unavailable. **Manual**: provider, model, base URL, API key. **Linked to a cc backend**: pick one of cc's Anthropic-compatible backends and a model |
| Embeddings | local | `local` (full image) or `openai` (any OpenAI-compatible endpoint: model, base URL, key) |
| Reranker | local | `local` (full image) or `rrf` (no model) |

- **Keys are write-only.** A stored key is never shown: the field says a key is stored; type a new one to replace it or tick **Remove the stored key**.
- **cc-backend link.** Backends whose URL is loopback (`127.0.0.0/8`, `localhost`, `::1`) are listed but disabled: a container cannot reach cc's loopback. Backends without `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` are disabled too. The URL and token are read from cc each time the API container is created and are never stored by the plugin.
- **Changing embeddings on existing memories is refused** (`EMBEDDINGS_CHANGED`): revert, or delete the data volume first.

## Images & data

Nothing is pulled, built, loaded or removed on its own: each is a button, one at a time, with its log shown live.

| Action | Needs | Does |
|---|---|---|
| Pull full image / Pull slim image | network | pulls the pinned official API image |
| Build CP image | network (once) | builds the control-plane image from the pinned upstream tag with this plugin's base path, inside a pinned docker CLI helper container |
| Upload and import | — | streams a bundle file from the browser into `docker load` |
| Import from a path | — | `docker load` of a `.tar` on cc's machine (absolute path) |
| Export | the images present | writes `code-hindsight-<version>-<variant>.tar` (the variant's API image + the CP image) to the plugin data dir and offers it for download; reports size and sha256 |
| Remove images | Hindsight stopped; confirm | removes the pinned API images and the CP image (and this plugin's stopped containers) |
| Delete data volume | Hindsight stopped; type the volume name | deletes every memory |

**Offline workflow:** on a machine with network access run Pull + Build CP image, then Export; carry the `.tar`; on the offline machine Import it, then Start.

## Errors

Every error is a code from `CATALOG` (`src/errors.js`); the Status card shows its title and message and offers its action:

| Code | Action button |
|---|---|
| `DOCKER_NOT_FOUND`, `NAME_TAKEN`, `BUSY` | — |
| `DOCKER_DENIED`, `PORT_IN_USE`, `EMBEDDINGS_CHANGED`, `SETTINGS_INVALID`, `SLIM_NEEDS_REMOTE_EMBEDDINGS`, `SLIM_NEEDS_RERANKER`, `CC_UNREACHABLE`, `CC_ROUTE_CHANGED`, `CC_BACKEND_MISSING`, `CC_BACKEND_UNSUPPORTED`, `CC_BACKEND_LOOPBACK` | Open Settings |
| `IMAGE_MISSING`, `IMAGE_MISMATCH` | Pull image |
| `CP_IMAGE_MISSING`, `CP_IMAGE_MISMATCH` | Build CP image |
| `DOCKER_DAEMON_DOWN`, `DOCKER_FAILED` | Start Hindsight |
| `UNHEALTHY`, `CRASHED`, `CP_LOGIN_FAILED` | Restart Hindsight |
| `CONTAINERS_RUNNING` | Stop Hindsight |
