// Shapes of the backend's /-/api/ responses (docs/protocol.md).

export type HindsightState = 'stopped' | 'checking' | 'starting' | 'ready' | 'stopping' | 'error';
export type ErrorAction = 'pull' | 'build-cp' | 'import' | 'start' | 'restart' | 'settings' | 'stop' | 'trust-cp';
export type Variant = 'full' | 'slim';

export interface CatalogError {
  code: string;
  title: string;
  message: string;
  action: ErrorAction | null;
  params: Record<string, unknown>;
}

export interface ImageInfo {
  ref: string;
  present: boolean;
  ok: boolean;
  id?: string | null;
  /** CP image only: carries this plugin's base-path and upstream labels. */
  built?: boolean;
  /** CP image only: its ID is the one this plugin built or the user confirmed. */
  trusted?: boolean;
  version?: string | null;
  revision?: string | null;
  basePath?: string | null;
  upstream?: string | null;
}

export interface ContainerInfo {
  name: string;
  state: string;
  exitCode?: number | null;
}

export interface Job {
  id: string;
  kind: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt: string | null;
  result: Record<string, unknown> | null;
  error: CatalogError | null;
  /** Registered (non-Docker) jobs report it; null otherwise. */
  progress: { done: number; total: number; unit: string } | null;
  cancellable: boolean;
  tail?: string;
}

export interface Status {
  state: HindsightState;
  error: CatalogError | null;
  docker: { mode: 'docker' | 'sudo' | null; serverVersion: string | null };
  variant: Variant;
  bindAddress: string;
  bindAuto: boolean;
  ports: { api: number; cp: number };
  images: { api: ImageInfo; cp: ImageInfo } | null;
  containers: { api: ContainerInfo; cp: ContainerInfo } | null;
  startedAt: string | null;
  pendingRestart: boolean;
  /** The data volume's name (typed to confirm its deletion). */
  volume: string;
  /** A previous backend could not stop the containers on SIGTERM. */
  lastShutdownFailure: { at: string; error: string } | null;
  llmMode: string;
  autoStart?: boolean;
  job: Job | null;
  bundles: { name: string; size: number }[];
  bundleNames: Record<Variant, string>;
}

export interface Settings {
  variant: Variant;
  docker: { allowSudo: boolean };
  network: { bindAddress: string | null; apiPort: number; cpPort: number };
  llm: { mode: 'none' | 'manual' | 'cc-backend'; provider: string | null; model: string | null; baseUrl: string | null; backendId: string | null };
  embeddings: { provider: string; model: string | null; baseUrl: string | null };
  reranker: { provider: string };
}

export interface SettingsView {
  settings: Settings;
  secrets: { llmApiKey: boolean; embeddingsApiKey: boolean };
  detectedBindAddress: string;
  choices: { variants: Variant[]; llmModes: Settings['llm']['mode'][]; embeddingsProviders: string[]; rerankerProviders: string[] };
  images: { api: Record<Variant, { ref: string; version: string }>; cp: string; version: string };
  /** On a save: user keys removed because their provider or URL changed. */
  cleared?: string[];
}

/** One image a bundle import loaded, with its trust standing. */
export interface LoadedImage { ref: string; id: string; status: 'pinned' | 'not-pinned' | 'trusted' | 'needs-confirmation' | 'unused' }

export interface FieldError { field: string; code?: string; message: string }

export interface CcBackend {
  id: string;
  label: string;
  host: string | null;
  usable: boolean;
  refusal: string | null;
  models: { model: string; label: string }[];
}

/** A memory scope as the backend stores it (docs/protocol.md → /-/api/scopes). An absent match key matches anything. */
export interface Scope {
  name: string;
  match: { projects?: string[]; workspaces?: string[]; sessions?: ('conductor' | 'worker')[]; stages?: string[] };
  bank: string;
  actions: ('recall' | 'retain')[];
}

export interface ScopesView {
  scopes: Scope[];
  choices: { actions: string[]; kinds: string[]; placeholders: string[]; limits: { maxScopes: number; nameMax: number; templateMax: number } };
}

export interface StagesView { stages: { name: string; playbooks: string[] }[]; error: string | null }

/** cc's projects (with the workspace each is in; null: none) and workspaces, for the scope pickers. */
export interface CcProjectsView {
  projects: { name: string; workspace: string | null }[];
  workspaces: { name: string; projectCount: number }[];
  error: string | null;
}

export interface BackfillEstimate { chunks: number; inputTokens: number; outputTokens: number }

/** One transcript segment a backfill scan found importable (docs/protocol.md → backfill-scan). */
export interface BackfillSession {
  key: string;
  handle: string;
  backingId: string;
  project: string;
  worktree: string;
  kind: 'conductor' | 'worker';
  stage: string | null;
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  turns: number;
  documents: number;
  chars: number;
  bank: string;
  scope: string;
  status: 'ready' | 'imported';
  /** Only turns before this (live memory's first turn) are imported. */
  cutoffAt: string | null;
  untimed: number;
  malformed: number;
  oversized: number;
  estimate: BackfillEstimate;
}

/** A transcript a scan did not offer, with the catalog code and message saying why. */
export interface BackfillSkip {
  key: string;
  handle: string | null;
  backingId: string;
  project?: string;
  worktree?: string;
  stage?: string | null;
  code: string;
  message: string;
}

export interface BackfillScan {
  scanId: string;
  scannedAt: string;
  scopesHash: string;
  /** False when Hindsight was not ready: already-imported sessions and live overlap were not checked. */
  hindsightChecked: boolean;
  llm: { mode: string; model: string | null };
  basis: { chunkChars: number; charsPerToken: number; promptTokensPerChunk: number; outputTokensPerChunk: number };
  totals: { files: number; ready: number; imported: number; skipped: number; cached: number; resolved: number; estimate: BackfillEstimate };
  sessions: BackfillSession[];
  skipped: BackfillSkip[];
}

export interface BackfillImportResult {
  sessions: number;
  documents: { sent: number; alreadyImported: number; queued: number; retried: number };
  failed: { key: string; code: string; message: string }[];
  skipped: { key: string; code: string; message: string }[];
  banks: string[];
}

/** One memory activity entry; never holds prompt or memory text. */
export interface ActivityEntry {
  at: string;
  /** recall, retain, mcp-recall, backfill-scan or backfill-import. */
  event: string;
  outcome: 'ok' | 'error' | 'skipped';
  sessionId?: string;
  project?: string;
  worktree?: string;
  stage?: string;
  kind?: string;
  banks?: string[];
  count?: number;
  code?: string;
  message?: string;
}
