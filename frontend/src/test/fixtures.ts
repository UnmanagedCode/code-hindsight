// Status/settings builders and a fetch stub for the component tests.
import { vi } from 'vitest';
import type { CatalogError, SettingsView, Status } from '@/lib/types';

export const status = (over: Partial<Status> = {}): Status => ({
  state: 'ready',
  error: null,
  docker: { mode: 'sudo', serverVersion: '29.9.2' },
  variant: 'full',
  bindAddress: '172.20.0.1',
  bindAuto: true,
  ports: { api: 18888, cp: 19999, relay: 18434 },
  images: { api: { ref: 'ghcr.io/vectorize-io/hindsight:1.2.1', present: true, ok: true }, cp: { ref: 'code-hindsight-cp:1.2.1', present: true, ok: true } },
  containers: { api: { name: 'code-hindsight-api', state: 'running' }, cp: { name: 'code-hindsight-cp', state: 'running' }, relay: { name: 'code-hindsight-relay', state: 'missing' } },
  startedAt: '2026-11-12T20:00:00.000Z',
  pendingRestart: false,
  volume: 'code-hindsight-data',
  lastShutdownFailure: null,
  llmMode: 'none',
  ollama: null,
  job: null,
  bundles: [],
  bundleNames: { full: 'code-hindsight-1.2.1-full.tar', slim: 'code-hindsight-1.2.1-slim.tar' },
  ...over,
});

export const catalogError = (code: string, action: CatalogError['action'], message = `${code} message`): CatalogError => ({ code, title: `${code} title`, message, action, params: {} });

export const settingsView = (over: Partial<SettingsView> = {}): SettingsView => ({
  settings: {
    variant: 'full',
    docker: { allowSudo: true },
    network: { bindAddress: null, apiPort: 18888, cpPort: 19999, relayPort: 18434 },
    llm: { mode: 'none', provider: null, model: null, baseUrl: null, backendId: null, maxConcurrent: null },
    embeddings: { provider: 'local', model: null, baseUrl: null },
    reranker: { provider: 'local' },
  },
  secrets: { llmApiKey: false, embeddingsApiKey: false },
  detectedBindAddress: '172.20.0.1',
  choices: { variants: ['full', 'slim'], llmModes: ['none', 'manual', 'cc-backend'], embeddingsProviders: ['local', 'openai'], rerankerProviders: ['local', 'rrf'], llmMaxConcurrentMax: 256 },
  images: { api: { full: { ref: 'ghcr.io/vectorize-io/hindsight:1.2.1', version: '1.2.1' }, slim: { ref: 'ghcr.io/vectorize-io/hindsight:1.2.1-slim', version: '1.2.1-slim' } }, cp: 'code-hindsight-cp:1.2.1', version: '1.2.1' },
  ...over,
});

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

/** Stub fetch: `handler` answers by URL; every call is recorded. */
export function stubFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init) ?? { status: 404, body: { code: 'NOT_FOUND', message: 'not stubbed' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
