> See also: [README](../README.md) · [protocol.md](protocol.md) · [architecture.md](architecture.md)

# Features

The plugin page is mounted at `/plugins/code-hindsight/` in cc. Its header shows **Code Hindsight**, a status pill (Hindsight's state, plus `sudo docker` when docker runs through sudo) and five tabs. The tab and the control-plane path live in the query string (`?view=cp|status|memory|settings|images&cp=<path>`), so a reload or a cc deep link (`http://cc.internal/#plugin/code-hindsight/?view=status`) lands on the same view.

The page opens on **Control plane** when Hindsight is ready, otherwise on **Status**.

## Control plane

- Hindsight's own control-plane UI, in a frame inside the page, signed in for you: you never type its access key.
- Follows cc's light/dark theme live.
- Navigating inside it adds no browser history entry, so Back leaves the plugin. The CP's path is mirrored into the page URL (`?view=cp&cp=/banks/<id>`).
- While Hindsight is not ready the tab shows the current error and its action instead of the frame.
- Signing out in the CP does nothing (the backend owns the session); the CP's login page sends you back to where you were.
- A control-plane URL opened from another website (or by a client that sends no fetch metadata) is refused 403; open the plugin from cc instead.

## Status

| Item | Shows |
|---|---|
| Error card | the error's title, message, code and one action button (see [Errors](#errors)) |
| Stop failure | when the previous backend could not stop the containers on SIGTERM: the reason (shown until Hindsight is next ready) |
| Auto-start hint | when cc reports Auto-start off for this plugin: Hindsight runs only while the plugin backend runs; switch on **Settings → Plugins → Code Hindsight → Auto-start** to have it up after every cc start |
| Settings changed | when the saved settings differ from the running containers: **Apply & restart** |
| Hindsight | state, docker invocation (`docker` or `sudo -n docker`) and daemon version, image variant, bind address and the host ports (the relay port while a backend is linked through the relay), LLM mode, ready-since time; **Start / Restart / Stop Hindsight** |
| Relay | only while the LLM goes through the relay: for Ollama, the daemon's version and URL (or that it is not answering); for a loopback cc backend, its endpoint URL and whether it answers; then the tunnel's state; a warning for `OLLAMA_UNREACHABLE` or `CC_BACKEND_UNREACHABLE`, and for `RELAY_DISCONNECTED` |
| Images and containers | the pinned API image and the CP image (present / missing / not the pinned or trusted ID), the containers' states (the relay container only while it exists), **API log** / **CP log** / **Relay log** (last 200 lines) |
| Job | the running or last job (a Docker action, or a backfill scan or import) with its log tail |

**Stop Hindsight** stops the API and control-plane containers (and the relay container and tunnel, while a backend is linked through the relay) and keeps them and the data volume. **Restart Hindsight** stops and starts them again (recreating any whose settings changed).

## Settings

Saved with **Save**; **Apply & restart** saves and reconciles the containers to the new settings. Every refusal is shown on its field.

| Setting | Default | Notes |
|---|---|---|
| Image | `full` | `slim` has no local models: refused (`SLIM_NEEDS_REMOTE_EMBEDDINGS`, `SLIM_NEEDS_RERANKER`) until embeddings are remote **with a key of their own** (`EMBEDDINGS_NEEDS_KEY` otherwise) and the reranker is `rrf` |
| Use `sudo -n docker` when docker is refused | on | sudo docker is root on the host |
| Bind address | automatic | the Docker host's address the API and control-plane ports (and the relay port, while a backend is linked through the relay) are published on; automatic = the container's default gateway when cc runs in a container, else `127.0.0.1`. An unspecified (`0.x`), multicast, reserved or broadcast address is refused |
| Relay port | `DEFAULT_SETTINGS` in `src/settings.js` | where the relay container publishes its tunnel port on the bind address; used only with an Ollama or loopback backend; must differ from the API and control-plane ports. Changing it flags **Apply & restart** even with no relayed backend (it is part of the container settings; no container is recreated for it) |
| API port / Control-plane port | `DEFAULT_SETTINGS` in `src/settings.js` | fixed so clients keep a stable URL; a clash is `PORT_IN_USE`, never a silent re-pick |
| LLM mode | None | **None**: memories are stored as chunks; reflect and observations are unavailable. **Manual**: provider, model, base URL, API key. **Linked to a cc backend**: pick one of cc's Anthropic-compatible backends (a loopback one runs through the relay), or cc's Ollama backend, and a model |
| Max parallel LLM requests | empty | every mode except None: caps the API's concurrent LLM calls (`HINDSIGHT_API_LLM_MAX_CONCURRENT`; empty = Hindsight's own default); a whole number up to `LLM_MAX_CONCURRENT_MAX` in `src/settings.js`. Hindsight recommends 1 for a local Ollama model |
| Embeddings | local | `local` (full image) or `openai` (any OpenAI-compatible endpoint: model, base URL, and a key of its own — refused `EMBEDDINGS_NEEDS_KEY` without one, so the LLM key is never sent there) |
| Reranker | local | `local` (full image) or `rrf` (no model) |

- **Keys are write-only.** A stored key is never shown: the field says a key is stored; type a new one to replace it or tick **Remove the stored key**.
- **A key follows its endpoint.** Saving a different LLM mode, provider or base URL — or a different embeddings provider or base URL — without typing the key again removes the stored key (the save message says so), so a repointed endpoint never receives it.
- **cc-backend link.** Backends whose URL is loopback (`127.0.0.0/8` in any literal spelling, `localhost`, `::1`, IPv4-mapped loopback) are offered as "(<host>, via relay)": the plugin reaches that endpoint in cc's container for the API and injects the backend's token itself (it never enters a container). Best-effort: literal addresses and `localhost`; a host name that resolves to loopback is not recognised, is linked directly and fails in the container. A loopback URL over `https` is listed but disabled ("loopback over https, not relayed"). Backends without `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` are disabled too. The URL and token are read from cc and never stored by the plugin: a direct row's are read each time the API container is created; a loopback row's on every Start/Restart (its token is held only by the plugin, so a changed token does not recreate the API container and raises no **Apply & restart**).
- **Models of an Anthropic-compatible backend.** The picker lists cc's models for the backend with Claude Code's launch tag (a trailing `[…]`, such as `[1m]`) removed, then the concrete `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` values of the row. A row with no concrete model value (absent, or a `{model}` placeholder) also offers **Other… (type a model id)**, which reveals a text input; the id is saved as typed. A backend with no listed models shows a plain text input.
- **Loopback privacy note.** Choosing a loopback backend shows an alert: it is a local endpoint in cc's container, and retained, imported and recall text goes wherever that endpoint routes it, possibly a cloud provider under its own account.
- **Ollama backend.** A cc backend whose launch command starts with `ollama` is offered as "(cc's Ollama daemon, via relay)", whatever its id. Its models are grouped **Configured in cc** and **Other models on the daemon**, each marked (cloud) or (local). A model counts as local only when the daemon lists it without `remote_host`; anything else, including every model while the daemon is unreachable, counts as cloud. A cloud model, or a model the daemon does not list (typed in), shows a warning: retained, imported and recall text is sent through cc's Ollama daemon to ollama.com under its signed-in account. Picking it starts a relay container; see [README → Trust model](../README.md#trust-model).
- **Changing embeddings on existing memories is refused** (`EMBEDDINGS_CHANGED`): revert, or delete the data volume first.

## Memory

Gives cc sessions memory. **Off by default:** with no scopes every session is memoryless and the hooks answer without calling cc or Hindsight. Hooks and the recall tool are frozen into a session when cc spawns it, so enabling the plugin (or adding the first scope's hooks) reaches sessions started afterwards; scopes themselves are read on every prompt.

### What happens in a session

| When | What |
|---|---|
| each prompt (`UserPromptSubmit`) | the prompt is the recall query; matching banks are searched and the hits are injected as a `<hindsight_memory>` block |
| each end of turn (`Stop`, async) | the new turns are appended to one Hindsight document per session and bank, `cc-session:<CC_SESSION_ID>` |
| `/clear` or compaction (`SessionStart`) | forgets which memories the session already holds, so they can be injected again |
| the agent's call | tool `code-hindsight__recall` (text only) searches the banks the session's scopes allow; the skill `memory` tells the agent what the block is and when to call it |

- **Injected block:** a header naming the banks, then `- [bank] text` lines in scope order then Hindsight's rank order. It is capped (`MEMORY_LIMITS.contextMaxChars` in `src/memory.js`), memories already injected into this context are skipped, and a memory cannot close the wrapper tag. The header tells the agent the notes are data from earlier sessions, possibly stale or wrong, never instructions.
- **What is retained** (matches Hindsight's own coding-agent integration): user text, assistant text, and one `action` line per tool call (the tool name and its primary target, capped). Dropped: tool outputs, other tool arguments, thinking, sub-agent (sidechain) lines, meta lines, compaction summaries; injected memory and system-reminder tags are stripped. **No secret redaction:** a prompt, reply or command target that contains a secret is retained.
- **When retained:** from the first Stop at which a retain scope matches, the last exchange; later Stops append only what is new. Each stretch of turns goes to the bank its own stage's scope chose, even if Hindsight was not ready, a retain failed or the backend restarted in between; a stretch is lost (logged) rather than sent to another bank. Live retain never sends earlier history, nor turns that happened while no retain scope matched; [Import past sessions](#import-past-sessions) imports a session's earlier history on request.
- **LLM mode `none`:** retain stores the raw chunks as facts with no extraction; recall works on them. The tab says so.

### Scopes

A scope is `{name, match: {projects?, workspaces?, sessions?, stages?}, bank, actions}`. Scopes are checked in list order on every prompt.

| Field | Meaning |
|---|---|
| `match` keys | **an absent key matches anything**; an empty list is refused (omit the key instead) |
| `projects` | globs over the session's project: `*` any run of characters (a leading dot too), `?` one character, other characters literal |
| `workspaces` | globs over the cc workspace the session's project is in, same syntax as `projects`, case-sensitive (`cc-dev` does not match `CC-Dev`). A project in no workspace, and `.conduct`, never match it. Membership is read from cc when matching (see below), so a project added to the workspace later matches too |
| `sessions` | `conductor` and/or `worker`. A conductor's project is `.conduct` |
| `stages` | the session's playbook stage must be listed. A session with no stage never matches a `stages` list. Names cc does not know are warned about in the UI and kept (playbooks come and go) |
| `bank` | a template with `{project}`, `{worktree}`, `{kind}`; literal text uses lowercase `a-z 0-9 . _ : -` |
| `actions` | `recall` and/or `retain` |

- **Combining keys:** a scope matches when `sessions` AND `stages` match AND (`projects` OR `workspaces` matches). With only one of `projects` / `workspaces` present, that one decides; with neither, any project matches.
- **Workspace lookup:** cc is asked for workspace membership only when some scope's outcome depends on it (its `sessions` and `stages` match, it has `workspaces`, and none of its `projects` globs matched); scope lists without `workspaces` never ask. If cc cannot answer, every scope that depends on it is undecided: it is neither a match nor a non-match (`WORKSPACE_UNRESOLVED`, see Degrading).
- **Workspace membership lag (known limitation):** membership is cached for `WORKSPACES_TTL_MS` (`src/ccSession.js`), so a project moved into or out of a workspace changes what it matches within that time. A project cc did not list in the cached copy is looked up again at once.
- **Recall** merges every matching scope that grants it, in order; the same bank twice counts once; at most `SCOPE_LIMITS.recallMaxBanks` banks (`src/scopes.js`).
- **Retain** goes to the **first** matching scope that grants it. If that scope's bank does not render, the session retains nothing (`BANK_RENDER_FAILED` in the activity log); it never falls through to a later scope. Likewise when the first retain scope not ruled out by its other keys is undecided (`WORKSPACE_UNRESOLVED`).
- **Bank rendering:** each placeholder value is lowercased, characters outside `a-z 0-9 . _ -` become `-`, runs collapse, leading `. _ -` is trimmed (`.conduct` → `conduct`); the main checkout's `{worktree}` is `main`. The result must be a valid bank id, else `BANK_RENDER_FAILED`. Different projects can sanitize to the same bank.
- **Stage and bank change mid-session:** the session is resolved on every call, so a stage change moves recall and retain to the matching scopes at once; later turns go to the new bank's `cc-session:<id>` document.

### The tab

- **Header:** says "Memory is off" when no scopes are saved; warns when Hindsight is not ready (sessions are memoryless) and when its LLM mode is `none`.
- **Scope editor:** ordered cards (move up/down, delete, **Add scope**) with name, projects (one glob per line), workspaces, sessions, stages (suggestions from cc's playbooks), bank template with a live preview, and actions. **Save** sends the whole list; a refusal (`SCOPES_INVALID`) shows against the field it names.
  - **Pick projects from cc:** a searchable list of cc's projects, each with its workspace (or "no workspace"); search matches the name or the workspace. Picking one adds its exact name as a new Projects line; lines already typed (globs too) are kept, and a name already present is not added twice.
  - **Workspaces:** chips with free text (globs such as `CC-*` can be typed) and **Pick workspaces from cc** (each with its project count). A literal name cc does not list is marked "unknown to cc" and kept.
  - **cc unreadable:** when cc's project or workspace list cannot be read, both pickers are hidden and a warning says to type the names; typing and **Save** work as usual.
- **Import past sessions:** see [below](#import-past-sessions).
- **Activity:** recent recalls, retains, past-session scans and imports, and refusals (time, event, session, project · stage, banks, count, result), newest first, refreshed every few seconds. Entries hold ids, names, counts and error text, never prompt or memory text. A prompt or Stop from a session that matches no scope leaves no entry (there would be one per prompt); the recall tool, by contrast, logs `NO_RECALL_SCOPE`.

### Import past sessions

A card on the Memory tab, between the scope editor and Activity, that retains past sessions' saved Claude Code transcripts into the banks their scopes choose. Nothing runs on its own, and nothing is sent before you confirm.

| Step | What happens |
|---|---|
| **Scan transcripts** | a job (progress, **Cancel**) that reads every `<backing id>.jsonl` under Claude Code's `projects` dir ([protocol](protocol.md#transcripts-root)), places each through cc, matches the scopes, and checks Hindsight for live overlap and earlier imports. It retains nothing |
| dry run | sessions grouped by target bank, **newest changed first** (by the transcript's modification time; a bank is placed by its newest session), **every ready session ticked**; each row shows title (or backing id), project · worktree · stage, first and last date, turns, and "only before <time>" when live memory already holds the rest, plus "replaces N outdated stored parts" / "deletes N stored parts no longer needed" when the bank holds an earlier import that no longer matches. Rows already imported (every part stored with exactly the content that would be sent) are shown, disabled. Skipped transcripts are counted per code with their message, each listable |
| estimate | for the ticked sessions: LLM mode and model, documents, chunks, input and output tokens. Type **$ per million input tokens** and **$ per million output tokens** (kept in the page only, never saved) to see a cost. Labelled rough (±50% or worse): Hindsight's chunking and extraction prompt decide the real use. LLM mode `none` costs no LLM tokens and hides the price inputs |
| **Import selected…** | a confirmation repeating the session count, the banks with their session counts and the estimate; only **Import N sessions** starts the import job (progress, **Cancel**) |

- **What is sent:** the same as live retain sends, verbatim: user and assistant text and one `action` line per tool call. Tool results, other tool arguments, thinking and sub-agent (sidechain) lines are dropped; **there is no secret redaction**. With an LLM configured, the imported turns also reach that LLM provider for extraction.
- **Eligible:** any transcript cc places (its `describe_session` record gives a project): cc-launched sessions and plain `claude` runs in a registered project. A session still running is skipped (`SESSION_LIVE`) and offered by a later scan once it ends.
- **Placement:** only cc's record decides, never the file's contents or its directory name. The session's **last recorded stage** places the whole transcript, then the scopes pick the bank exactly as for live retain (first matching retain scope). A transcript cc cannot place, or that no retain scope matches, is skipped and reported, never sent to a default bank.
- **Overlap with live memory:** only turns earlier than the first turn of the session's live document (`cc-session:<id>`, in any bank a retain scope renders for it) are imported; turns without a timestamp are then left out. A session wholly covered is `ALREADY_LIVE`. A live document in a bank no current retain scope renders for the session (a scope renamed or removed since) is not seen; the cursor store cannot fill that gap, since it keeps no bank once a session's turns are sent.
- **Re-running** is safe: a part Hindsight already holds with exactly the content that would be sent is not sent again, an operation still queued is left alone, and a failed one is retried. A stored part whose content differs (live memory's start moved earlier since the last import) is replaced, and stored parts numbered past what is sent now are deleted, with the memories extracted from them.
- **The import sends only what the dry run showed:** for each session it re-checks the file and live memory's start. If either differs from the scan (`TRANSCRIPT_CHANGED`: the file's size, modification time, identity or content; `LIVE_CUTOFF_MOVED`: live memory now starts elsewhere), the session is skipped with nothing sent or deleted; scan again. A session stopped mid-import (Cancel, Hindsight going away, or the file changing between its two reads) may already have sent some of its confirmed parts, never anything unconfirmed; a re-run finishes it. Only the orphaned parts the scan listed are deleted, highest first, so an interrupted import leaves parts the next scan finds.
- **Bank settings that defeat the content check:** with a bank's `store_document_text` off, or Hindsight's sensitive-data redaction on, a stored part never matches what would be sent: it shows as outdated and the session never reads as imported. Nothing is extracted twice: the operation check sees the part's operation and does not resend it.
- **Incremental scans:** a scan reads each transcript at most once, streaming it without keeping its text. What cc said about each file, and the file's parse summary, are cached while its size and modification time are unchanged, so a re-scan asks cc only about new or changed files. The first scan asks cc about every transcript and can take many minutes. Tick **Resolve every transcript again (ignore cached placements)** to ignore the cache.
- **Pacing:** one request at a time, so live hooks keep their budget. With an LLM configured, Hindsight's extraction of a large import delays extraction of later live retains (they are still acknowledged at once).
- **Hindsight not ready:** a scan still places sessions but cannot check overlap or earlier imports (the card says so) and **Import** is disabled, and the backend refuses to import from that scan (`BACKFILL_UNCHECKED`); an import is refused `HINDSIGHT_NOT_READY`; Hindsight going away mid-import stops the job (`RETAIN_FAILED`), keeping what was sent, and a re-run resumes; so does an authentication refusal (HTTP 401 or 403). A refusal of one session's item (any other HTTP 4xx) fails that session only.
- **Activity:** one entry per scan and per import (counts and banks; an import counts sessions finished and documents sent separately, since a stopped session may have sent some of its parts), plus one per failed session. An import that was cancelled is logged `skipped`, one that stopped `error`. Per-session detail is in the job log.
- **Refusals:** `BACKFILL_NO_SCOPES` (no scope grants retain), `BACKFILL_CC_UNAVAILABLE` (no cc, or cc failing repeatedly), `BACKFILL_STALE` ("scan again": scopes changed or a newer scan exists), `BACKFILL_UNCHECKED` ("scan again once Hindsight is ready"), `CONFIRMATION_REQUIRED`, `HINDSIGHT_NOT_READY`.

| Skip code | Why the transcript is not offered |
|---|---|
| `BACKFILL_UNPLACEABLE` | cc has no project for it (its reason is shown), or did not answer |
| `SESSION_LIVE` | the session is still running |
| `NO_RETAIN_SCOPE` | no scope grants retain to the session |
| `WORKSPACE_UNRESOLVED`, `BANK_RENDER_FAILED` | as for live retain: the first retain scope is undecided, or its bank does not render |
| `LIVE_RETAIN_PENDING` | live retain still holds unsent turns of this session |
| `LIVE_OVERLAP_UNKNOWN` | its live document has no readable turn timestamps |
| `LIVE_CUTOFF_MOVED` | (import only) live memory's start moved since the scan |
| `ALREADY_LIVE` | live memory already holds all of it |
| `TRANSCRIPT_TOO_LARGE`, `TRANSCRIPT_UNREADABLE`, `TRANSCRIPT_EMPTY`, `TRANSCRIPT_CHANGED` | the file is over `BACKFILL_LIMITS.fileMaxBytes` (`src/backfill.js`), cannot be read, holds no turns, or (import only) is not what the scan read: size, modification time, file identity or content |
| `TRANSCRIPT_SESSION_TOO_LARGE` | its turns render to more than `BACKFILL_LIMITS.sessionMaxChars` |
| `TRANSCRIPT_TURN_TOO_LARGE` | one turn renders to more than `BACKFILL_LIMITS.documentMaxChars`, the largest document sent; nothing is truncated |

### Degrading

Every failure yields a memoryless turn and an Activity entry; the hooks always exit 0 and a Stop can never keep a session running.

| Condition | Activity code |
|---|---|
| cc could not place the session | `SESSION_UNRESOLVED` |
| session retired or unknown | `SESSION_NOT_LIVE` |
| Hindsight not ready (retain resends later) | `HINDSIGHT_NOT_READY` |
| a bank's recall failed or timed out (other banks still answer) | `RECALL_FAILED` |
| retain failed (the same batch is resent with the next turn) | `RETAIN_FAILED` |
| a bank template did not render | `BANK_RENDER_FAILED` |
| cc could not say which workspace the session's project is in (cc unset, unreachable, slower than `WORKSPACES_TIMEOUT_MS`, a bad answer, the project missing from cc's list or its record unreadable). One entry per undecided scope. Recall: that scope adds no bank, other matching scopes still recall. Retain: when it is the first retain scope not ruled out, nothing is recorded or sent (never to a later scope); the next Stop that resolves takes those turns into its own bank. Recall tool: answers this code instead of `NO_RECALL_SCOPE` when no other scope gave a bank | `WORKSPACE_UNRESOLVED` |
| stored retain progress was unreadable (one entry of the wrong shape, or the whole file, moved aside) and was reset; the next retain starts from the last exchange | `CURSOR_INVALID` |
| a Stop's turns were stamped beyond the clock-skew allowance (`MEMORY_LIMITS.clockSkewMs`) in the future and were not recorded | `RETAIN_FUTURE` |
| a late Stop's turns were already behind the retained position and were ignored (nothing lost, nothing sent twice) | `RETAIN_STALE` |
| turns could not be kept for later: the session's backlog of unsent windows overflowed (`MEMORY_LIMITS.retainQueueMax`), or a window's turns left the transcript tail (a `/clear` or trim) before they could be sent. They are never sent to another bank | `RETAIN_DROPPED` |
| `scopes.json` unreadable | `SCOPES_INVALID` |

Two losses are not logged: a window of turns that is only partly still in the transcript tail loses its trimmed part silently (only a window with nothing left is reported), and after a `/clear` or trim a never-sent turn stamped in exactly the same millisecond as the retained boundary is excluded.

A stopped or crashed plugin backend cannot log anything: the hooks give up at their deadline and cc's plugin row is the only sign.

## Images & data

Nothing is pulled, built, loaded or removed on its own: each is a button, one at a time, with its log shown live.

| Action | Needs | Does |
|---|---|---|
| Pull full image / Pull slim image | network | pulls the pinned official API image |
| Build CP image | network (once) | builds the control-plane image from the pinned upstream commit with this plugin's base path, inside the docker CLI helper image (pulled by digest when missing; run only if its ID is pinned). The built image's ID becomes the trusted CP image |
| Upload and import | — | streams a bundle file from the browser into `docker load`; lists each loaded image's ID and whether it will run (pinned / not pinned / trusted / needs confirmation), and next to them the IDs the bundle's manifest lists (a bundle this plugin exported) |
| Import from a path | — | the same for a `.tar` on cc's machine (absolute path) |
| Trust this image… | a CP image that is not trusted | shows the control-plane image's ID; confirming trusts exactly that ID (for a bundle you exported yourself, compare it with the IDs the export showed). This guards against running an unexpected image by accident — a wrong tarball, a stale import — not against a caller that can reach the plugin API, which can import and confirm an image itself ([README → Trust model](../README.md#trust-model)) |
| Export | the images present | writes `code-hindsight-<version>-<variant>.tar` (the variant's API image + the CP image, plus a `code-hindsight-bundle.json` listing their IDs) to the plugin data dir and offers it for download; shows size, sha256 and the image IDs |
| Remove images | Hindsight stopped; confirm | removes the pinned API images and the CP image (and this plugin's stopped containers) |
| Delete data volume | Hindsight stopped; type the volume name | deletes every memory |

**Offline workflow:** on a machine with network access run Pull + Build CP image, then Export (note the IDs it reports); carry the `.tar`; on the offline machine Import it, check the IDs, **Trust this image…** for the control-plane image, then Start. The API image needs no confirmation: its ID is pinned.

Only Pull, Build CP image, Import and Trust can start Hindsight afterwards (when it was asked to run and is waiting on an image); Export, Remove images and Delete data volume never do.

## Errors

Every error is a code from `CATALOG` (`src/errors.js`); the Status card shows its title and message and offers its action:

| Code | Action button |
|---|---|
| `DOCKER_NOT_FOUND`, `NAME_TAKEN`, `BUSY`, `HELPER_UNTRUSTED`, `JOB_NOT_CANCELLABLE` | — |
| `CP_IMAGE_UNTRUSTED` | Review the image (opens Images & data) |
| `DOCKER_DENIED`, `PORT_IN_USE`, `EMBEDDINGS_CHANGED`, `SETTINGS_INVALID`, `SLIM_NEEDS_REMOTE_EMBEDDINGS`, `SLIM_NEEDS_RERANKER`, `EMBEDDINGS_NEEDS_KEY`, `CC_UNREACHABLE`, `CC_ROUTE_CHANGED`, `CC_BACKEND_MISSING`, `CC_BACKEND_UNSUPPORTED`, `CC_BACKEND_LOOPBACK` (loopback over `https`) | Open Settings |
| `IMAGE_MISSING`, `IMAGE_MISMATCH` | Pull image |
| `CP_IMAGE_MISSING`, `CP_IMAGE_MISMATCH` | Build CP image |
| `DOCKER_DAEMON_DOWN`, `DOCKER_FAILED` | Start Hindsight |
| `UNHEALTHY`, `CRASHED`, `CP_LOGIN_FAILED`, `RELAY_DISCONNECTED` | Restart Hindsight |
| `OLLAMA_UNREACHABLE` | — (a Status warning: start `ollama serve` in cc's container) |
| `CC_BACKEND_UNREACHABLE` | — (a Status warning: start the linked backend's endpoint in cc's container) |
| `CONTAINERS_RUNNING` | Stop Hindsight |
| `HINDSIGHT_NOT_READY` | Start Hindsight |
| `SCOPES_INVALID`, `BROWSER_REFUSED`, `NO_SESSION`, `SESSION_UNRESOLVED`, `SESSION_NOT_LIVE`, `WORKSPACE_UNRESOLVED`, `NO_RECALL_SCOPE`, `RECALL_FAILED`, `RETAIN_FAILED`, `RETAIN_DROPPED`, `RETAIN_STALE`, `RETAIN_FUTURE`, `CURSOR_INVALID`, `BANK_RENDER_FAILED` | — (Memory-tab and hook/tool errors: shown against a field, in Activity, or to the tool caller) |
| `BACKFILL_NO_SCOPES`, `BACKFILL_CC_UNAVAILABLE`, `BACKFILL_STALE`, `BACKFILL_UNCHECKED` and the [skip codes](#import-past-sessions) | — (Import past sessions: a refusal, a failed job, or a skipped row) |
