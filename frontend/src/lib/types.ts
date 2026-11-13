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
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt: string | null;
  result: Record<string, unknown> | null;
  error: CatalogError | null;
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
  match: { projects?: string[]; sessions?: ('conductor' | 'worker')[]; stages?: string[] };
  bank: string;
  actions: ('recall' | 'retain')[];
}

export interface ScopesView {
  scopes: Scope[];
  choices: { actions: string[]; kinds: string[]; placeholders: string[]; limits: { maxScopes: number; nameMax: number; templateMax: number } };
}

export interface StagesView { stages: { name: string; playbooks: string[] }[]; error: string | null }

/** One memory activity entry; never holds prompt or memory text. */
export interface ActivityEntry {
  at: string;
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
