// GPU compute's proof: which device the API's local models loaded on, read from the lines the
// pinned upstream logs once per model load (`Embeddings: local provider initialized (…, device: X)`,
// `Reranker: local provider initialized (device: X, …)`). Upstream falls back to the CPU silently
// when torch sees no CUDA, so these lines are the only evidence; re-check them when bumping Hindsight.
import { AppError } from './errors.js';

const LINES = Object.freeze({
  embeddings: /Embeddings: local provider initialized \([^)]*\bdevice: ([A-Za-z0-9_:]+)/,
  reranker: /Reranker: local provider initialized \(device: ([A-Za-z0-9_:]+)/,
});

/**
 * Collects the devices from log lines fed one at a time; the last start line of each model wins.
 * @returns {{line(l: string): void, devices(): {embeddings: string|null, reranker: string|null}}}
 */
export function deviceReader() {
  const found = { embeddings: null, reranker: null };
  return {
    line(l) {
      for (const [model, re] of Object.entries(LINES)) {
        const m = re.exec(l);
        if (m) found[model] = m[1];
      }
    },
    devices: () => ({ ...found }),
  };
}

/** The devices named in a log text. */
export function parseModelDevices(logText) {
  const r = deviceReader();
  for (const l of String(logText ?? '').split(/\r?\n/)) r.line(l);
  return r.devices();
}

/** The models settings run locally: only these load on a device. */
const localModels = (settings) => [
  ...(settings.embeddings.provider === 'local' ? ['embeddings'] : []),
  ...(settings.reranker.provider === 'local' ? ['reranker'] : []),
];

/**
 * Judge the devices against the settings. `missing`: local models with no start line;
 * `notCuda`: local models that loaded on something else.
 */
export function judgeDevices(devices, settings) {
  const models = localModels(settings);
  return {
    missing: models.filter((m) => !devices[m]),
    notCuda: models.filter((m) => devices[m] && devices[m] !== 'cuda'),
  };
}

/** Throws GPU_NOT_USED unless every local model loaded on cuda. */
export function assertOnCuda(devices, settings) {
  const { missing, notCuda } = judgeDevices(devices, settings);
  if (missing.length || notCuda.length) {
    const models = localModels(settings);
    throw new AppError('GPU_NOT_USED', Object.fromEntries(models.map((m) => [m, devices[m] ?? null])));
  }
}
