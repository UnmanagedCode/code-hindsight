// Hindsight's lifecycle: check docker, images and settings; create or adopt the network,
// volume and two containers; wait for health; watch; stop. Hindsight's state is its own
// state machine, separate from the backend's health route (cc counts the backend ready on
// any HTTP answer, so the backend answers at once and reports Hindsight here).
//
// States: stopped → checking → starting → ready, plus stopping and error{code}.
//
// GPU compute runs the API from the GPU image with the host's GPUs, and is ready only once the
// API's own start lines say its local models loaded on cuda (gpuCheck.js); otherwise the API is
// stopped, never left running on the CPU.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { API_GPU_IMAGE, API_IMAGES, BASE_PATH, CP_IMAGE, GPU_TORCH_FLAVOR, LABELS, RELAY_TARGETS, UPSTREAM_REVISION } from './pins.js';
import { isOurCpBuild, isOurGpuBuild } from './trust.js';
import { deviceReader, judgeDevices, assertOnCuda } from './gpuCheck.js';
import { AppError, describeError, toAppError } from './errors.js';
import { validateSettings, embeddingsFingerprint, containerSettingsHash } from './settings.js';
import { apiSpec, cpSpec, relaySpec, embeddingsEnv } from './containerSpec.js';
import { composeLlmEnv } from './llmEnv.js';
import { readJsonFile, writePrivateFileAtomic } from './fsPrivate.js';

export const DEFAULT_TIMEOUTS = Object.freeze({
  /** First start initialises Postgres and loads models: minutes on a slow disk. */
  apiHealthMs: 10 * 60_000,
  cpHealthMs: 2 * 60_000,
  pollMs: 1_000,
  watchMs: 15_000,
  /** Consecutive failed watch probes before a running API counts as unhealthy. */
  watchFailures: 3,
  /** How long a new backend waits for the previous one's detached `docker stop`. */
  pendingStopMs: 90_000,
  stopSeconds: 30,
  /** The shutdown's look at the relay container: bounded, because cc's kill grace is short. */
  shutdownProbeMs: 1_500,
});

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
};

/** GET `url`; resolves the status code, or 0 when nothing answered. */
export function httpProbe(url, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

class Cancelled extends Error {}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * @param {object} o
 * @param {ReturnType<import('./docker.js').createDocker>} o.docker
 * @param {ReturnType<import('./settings.js').createSettingsStore>} o.settings
 * @param {ReturnType<import('./secrets.js').createSecretsStore>} o.secrets
 * @param {ReturnType<import('./containerSpec.js').resourceNames>} o.names
 * @param {string} o.owner ownership label value (containerSpec.ownerId)
 * @param {string} o.dataDir
 * @param {() => string} o.detectBind the automatic bind address
 * @param {() => Promise<unknown>} o.fetchCcModels
 * @param {{token(): Promise<string>, clear(): void}} o.cpSession
 * @param {{start(addr: {host: string, port: number}, target: object): void, stop(): void, status(): object}} o.relay the plugin's side of the relay: the tunnel, and the target it serves (what composeLlmEnv returns as `relay`)
 * @param {(url: string) => Promise<number>} [o.probe]
 * @param {{now(): number, sleep(ms: number): Promise<void>}} [o.clock]
 * @param {Partial<typeof DEFAULT_TIMEOUTS>} [o.timeouts]
 * @param {boolean} [o.watch] poll health while ready (tests drive `checkHealth()` instead)
 */
export function createSupervisor({
  docker, settings: settingsStore, secrets: secretsStore, names, owner, dataDir,
  detectBind, fetchCcModels, cpSession, relay, probe = httpProbe, clock = realClock, timeouts = {}, watch = true,
  log = (m) => console.error(`code-hindsight: ${m}`),
}) {
  const T = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const stoppingFile = path.join(dataDir, 'stopping.json');
  const shutdownFailedFile = path.join(dataDir, 'shutdown-failed.json');
  /** A previous backend's failed SIGTERM stop, shown until Hindsight is next ready. */
  let lastShutdownFailure = readJsonFile(shutdownFailedFile, null);
  let state = 'stopped';
  let error = null;
  let startedAt = null;
  let bind = null;
  let ports = null;
  let appliedKey = null;
  let images = null;
  let containers = null;
  /** Whether the running API's LLM goes through the relay (an Ollama or a loopback cc backend). */
  let relayLinked = false;
  let wantRunning = false;
  let generation = 0;
  let queue = Promise.resolve();
  /** Bumped to end the running watch loop; each loop runs only while its token is current. */
  let watchToken = 0;
  let watchFailures = 0;
  /** GPU compute: the API start whose devices were checked ({startedAt, devices}), else null. */
  let gpuChecked = null;

  const set = (s, e = null) => { state = s; error = e; };
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const checkCancelled = (gen) => { if (gen !== generation) throw new Cancelled(); };

  function currentSettings() {
    const has = secretsStore.has();
    return validateSettings(settingsStore.get(), { embeddingsApiKey: has.embeddingsApiKey });
  }

  function appliedKeyOf(settings) {
    const s = secretsStore.get();
    return crypto.createHash('sha256').update(JSON.stringify([containerSettingsHash(settings), s.llmApiKey ?? '', s.embeddingsApiKey ?? ''])).digest('hex');
  }

  async function waitPendingStop() {
    const pending = readJsonFile(stoppingFile, null);
    if (!pending) return;
    const deadline = clock.now() + T.pendingStopMs;
    // A pid recorded long ago may have been reused; only a recent stop is waited for.
    if (Number.isInteger(pending.pid) && clock.now() - (pending.at ?? 0) < T.pendingStopMs) {
      while (pidAlive(pending.pid) && clock.now() < deadline) await clock.sleep(T.pollMs);
    }
    fs.rmSync(stoppingFile, { force: true });
  }

  function settingsError(errors) {
    const named = errors.find((e) => e.code);
    return named ? new AppError(named.code, { field: named.field }) : new AppError('SETTINGS_INVALID', { fields: errors });
  }

  async function inspectImages(variant) {
    const want = API_IMAGES[variant];
    const api = await docker.inspectImage(want.ref);
    const cp = await docker.inspectImage(CP_IMAGE);
    const gpu = await docker.inspectImage(API_GPU_IMAGE);
    const apiLabels = api?.Config?.Labels ?? {};
    const cpLabels = cp?.Config?.Labels ?? {};
    const gpuLabels = gpu?.Config?.Labels ?? {};
    const built = isOurCpBuild(cp);
    const gpuBuilt = isOurGpuBuild(gpu);
    images = {
      api: {
        ref: want.ref, present: !!api, id: api?.Id ?? null,
        version: apiLabels['org.opencontainers.image.version'] ?? null,
        ok: !!api,
      },
      cp: {
        ref: CP_IMAGE, present: !!cp, id: cp?.Id ?? null,
        basePath: cpLabels[LABELS.basePath] ?? null, upstream: cpLabels[LABELS.upstream] ?? null,
        built,
        ok: built,
      },
      gpu: {
        ref: API_GPU_IMAGE, present: !!gpu, id: gpu?.Id ?? null,
        upstream: gpuLabels[LABELS.upstream] ?? null, cuda: gpuLabels[LABELS.cuda] ?? null,
        built: gpuBuilt,
        ok: gpuBuilt,
      },
    };
    return { api, cp, gpu, want };
  }

  async function inspectContainers() {
    const one = async (name) => {
      const c = await docker.inspectContainer(name);
      if (!c) return { name, state: 'missing' };
      return { name, state: c.State?.Status ?? 'unknown', running: !!c.State?.Running, restarting: !!c.State?.Restarting, exitCode: c.State?.ExitCode ?? null, ours: c.Config?.Labels?.[LABELS.owner] === owner };
    };
    containers = { api: await one(names.api), cp: await one(names.cp), relay: await one(names.relay) };
    return containers;
  }

  async function ensureOwned(kind, name, inspectFn, createFn, extraCheck) {
    const found = await inspectFn(name);
    if (!found) { await createFn(); return; }
    if (found.Labels?.[LABELS.owner] !== owner) throw new AppError('NAME_TAKEN', { kind, name });
    extraCheck?.(found);
  }

  async function adoptOrCreate(spec, imageId, portSetting) {
    const portError = (e) => {
      if (e instanceof AppError && e.code === 'PORT_IN_USE') {
        const port = { apiPort: ports.api, cpPort: ports.cp, relayPort: ports.relay }[portSetting];
        return new AppError('PORT_IN_USE', { port, address: bind, setting: `network.${portSetting}` });
      }
      return e;
    };
    const c = await docker.inspectContainer(spec.name);
    if (c) {
      const labels = c.Config?.Labels ?? {};
      if (labels[LABELS.owner] !== owner) throw new AppError('NAME_TAKEN', { kind: 'container', name: spec.name });
      if (labels[LABELS.spec] === spec.hash && c.Image === imageId) {
        if (c.State?.Running) return 'adopted';
        try { await docker.startContainer(spec.name); } catch (e) { throw portError(e); }
        return 'started';
      }
      // A different spec or image: replace the container; the data volume is kept.
      if (c.State?.Running) await docker.stopContainers([spec.name], T.stopSeconds);
      await docker.removeContainer(spec.name);
    }
    try { await docker.runContainer(spec); } catch (e) { throw portError(e); }
    return 'created';
  }

  /** An unlinked relay is removed (kept stopped it would still hold the plugin network). */
  async function removeOwnedRelay() {
    const c = await docker.inspectContainer(names.relay);
    if (c && c.Config?.Labels?.[LABELS.owner] === owner) await docker.removeContainer(names.relay);
  }

  async function containerTail(name) {
    try { return (await docker.logs(name, 40)).split('\n').slice(-40).join('\n'); } catch { return ''; }
  }

  async function crashedOrNull(role, name) {
    const c = await docker.inspectContainer(name);
    if (!c || c.State?.Running || c.State?.Restarting) return null;
    return new AppError('CRASHED', { role, exitCode: c.State?.ExitCode ?? null, tail: await containerTail(name) });
  }

  async function waitHealthy(url, role, name, timeoutMs, gen) {
    const deadline = clock.now() + timeoutMs;
    let n = 0;
    for (;;) {
      checkCancelled(gen);
      if ((await probe(url)) === 200) return;
      if (n++ % 5 === 4) {
        const crashed = await crashedOrNull(role, name);
        if (crashed) throw crashed;
      }
      if (clock.now() >= deadline) throw new AppError('UNHEALTHY', { role, url, tail: await containerTail(name) });
      await clock.sleep(T.pollMs);
    }
  }

  /** Stop the API container (kept, with the volume); a failure is logged, the caller's error stands. */
  async function stopApiQuietly() {
    try { await docker.stopContainers([names.api], T.stopSeconds); } catch (e) { log(`stopping the API after a failed GPU check: ${e?.message ?? e}`); }
  }

  /** The devices the API's current start logged ({startedAt, devices}), read from that start's log window. */
  async function readDevices() {
    const c = await docker.inspectContainer(names.api);
    const startedAt = c?.State?.StartedAt ?? null;
    const reader = deviceReader();
    if (startedAt) {
      const until = new Date(Date.parse(startedAt) + T.apiHealthMs).toISOString();
      await docker.logLines(names.api, { since: startedAt, until }, reader.line);
    }
    return { startedAt, devices: reader.devices() };
  }

  /**
   * GPU compute's check after the API answered: its local models must have loaded on cuda.
   * An adopted container whose start lines are no longer in its log (a daemon `log-opts`
   * max-size rotates them out) is recreated once, so the check reads a fresh start; a line
   * naming another device is never retried. Any failure stops the API.
   */
  async function verifyGpu(settings, spec, imageId, outcome, gen) {
    try {
      let read = await readDevices();
      const { missing, notCuda } = judgeDevices(read.devices, settings);
      if (outcome === 'adopted' && missing.length && !notCuda.length) {
        log(`GPU check: the adopted API's start lines (${missing.join(', ')}) are not in its log; recreating it`);
        await docker.stopContainers([names.api], T.stopSeconds);
        await docker.removeContainer(names.api);
        await adoptOrCreate(spec, imageId, 'apiPort');
        await waitHealthy(`http://${bind}:${ports.api}/health`, 'api', names.api, T.apiHealthMs, gen);
        read = await readDevices();
      }
      assertOnCuda(read.devices, settings);
      gpuChecked = read;
    } catch (e) {
      if (!(e instanceof Cancelled)) await stopApiQuietly();
      throw e;
    }
  }

  async function bringUp(gen) {
    set('checking');
    await waitPendingStop();
    checkCancelled(gen);
    await docker.resolve();
    const { settings, errors } = currentSettings();
    if (errors.length) throw settingsError(errors);
    bind = settings.network.bindAddress ?? detectBind();
    ports = { api: settings.network.apiPort, cp: settings.network.cpPort, relay: settings.network.relayPort };

    const { api, cp, gpu, want } = await inspectImages(settings.variant);
    const onGpu = settings.compute === 'gpu';
    // Both checks come before any container is touched.
    if (onGpu) {
      if (!gpu) throw new AppError('GPU_IMAGE_MISSING', { image: API_GPU_IMAGE });
      if (!images.gpu.built) throw new AppError('GPU_IMAGE_MISMATCH', { image: API_GPU_IMAGE, found: `upstream ${images.gpu.upstream ?? '?'}, torch ${images.gpu.cuda ?? '?'}`, expected: `upstream ${UPSTREAM_REVISION}, torch ${GPU_TORCH_FLAVOR}` });
    } else if (!api) throw new AppError('IMAGE_MISSING', { image: want.ref });
    const apiImage = onGpu ? gpu : api;
    if (!cp) throw new AppError('CP_IMAGE_MISSING', { image: CP_IMAGE });
    if (!images.cp.built) throw new AppError('CP_IMAGE_MISMATCH', { image: CP_IMAGE, found: `${images.cp.basePath ?? '?'} @ ${images.cp.upstream ?? '?'}`, expected: `${BASE_PATH} @ ${UPSTREAM_REVISION}` });

    const baseLabels = { [LABELS.managed]: '1', [LABELS.owner]: owner };
    await ensureOwned('network', names.network, docker.inspectNetwork, () => docker.createNetwork(names.network, baseLabels));
    const fp = embeddingsFingerprint(settings);
    await ensureOwned('volume', names.volume, docker.inspectVolume, () => docker.createVolume(names.volume, { ...baseLabels, [LABELS.embeddings]: fp }), (v) => {
      const current = v.Labels?.[LABELS.embeddings];
      if (current !== fp) throw new AppError('EMBEDDINGS_CHANGED', { volume: names.volume, current: current ?? 'unknown', wanted: fp });
    });
    checkCancelled(gen);

    set('starting');
    const secrets = secretsStore.get();
    const { env: llmEnv, relay: relayTarget } = await composeLlmEnv(settings, secrets, { fetchCcModels });
    // A start cancelled while the LLM env was read must not bring the tunnel up.
    checkCancelled(gen);
    if (relayTarget) {
      // The relay first: the API's LLM client resolves the target's alias on the private network.
      await adoptOrCreate(relaySpec({ names, image: { id: apiImage.Id }, bind, port: ports.relay, key: secrets.relayKey, owner, target: RELAY_TARGETS[relayTarget.kind] }), apiImage.Id, 'relayPort');
      checkCancelled(gen);
      relay.start({ host: bind, port: ports.relay }, relayTarget);
      relayStarted = true;
    } else {
      relay.stop();
      relayLinked = false; // before the removal can throw: status must not show a relay that is no longer served
      await removeOwnedRelay();
    }
    relayLinked = relayTarget !== null;
    const apiS = apiSpec({ names, image: { id: apiImage.Id }, variant: settings.variant, compute: settings.compute, bind, port: ports.api, apiKey: secrets.apiKey, llmEnv, embeddingsEnv: embeddingsEnv(settings, secrets), owner });
    const apiOutcome = await adoptOrCreate(apiS, apiImage.Id, 'apiPort');
    const cpS = cpSpec({ names, image: { id: cp.Id }, bind, port: ports.cp, apiKey: secrets.apiKey, accessKey: secrets.cpAccessKey, owner });
    await adoptOrCreate(cpS, cp.Id, 'cpPort');
    await inspectContainers();
    checkCancelled(gen);

    await waitHealthy(`http://${bind}:${ports.api}/health`, 'api', names.api, T.apiHealthMs, gen);
    if (onGpu) await verifyGpu(settings, apiS, apiImage.Id, apiOutcome, gen);
    checkCancelled(gen);
    await waitHealthy(`http://${bind}:${ports.cp}${BASE_PATH}/api/health`, 'cp', names.cp, T.cpHealthMs, gen);
    cpSession.clear();
    await cpSession.token();
    checkCancelled(gen);
    appliedKey = appliedKeyOf(settings);
    startedAt = new Date(clock.now()).toISOString();
    await inspectContainers();
    set('ready');
    if (lastShutdownFailure) { lastShutdownFailure = null; fs.rmSync(shutdownFailedFile, { force: true }); }
    startWatch();
  }

  /** Whether the current start attempt reached `relay.start`: only then is the relay this attempt's to undo. */
  let relayStarted = false;

  async function runBringUp() {
    const gen = ++generation;
    relayStarted = false;
    gpuChecked = null;
    stopWatch();
    try {
      await bringUp(gen);
    } catch (e) {
      if (e instanceof Cancelled) {
        // stop()/restart() ended this start: whatever it began with the tunnel ends with it.
        relay.stop();
        relayLinked = false;
        return;
      }
      // A failure before the relay step touches nothing: the previous tunnel keeps serving the running API.
      // A failure after it ends what this attempt began, so no tunnel, token or relay container outlives it.
      if (relayStarted) {
        relay.stop();
        relayLinked = false;
        try { await removeOwnedRelay(); } catch (re) { log(`removing the relay after a failed start: ${re?.message ?? re}`); }
      }
      const err = toAppError(e, 'DOCKER_FAILED', { command: 'start' });
      if (!(e instanceof AppError)) log(`start failed: ${e?.stack ?? e}`);
      set('error', err.toJSON());
      try { if (docker.info().mode) await inspectContainers(); } catch { /* status stays as last known */ }
    }
  }

  function startWatch() {
    if (!watch) return;
    const token = ++watchToken; // ends any earlier loop
    watchFailures = 0;
    (async () => {
      for (;;) {
        await clock.sleep(T.watchMs);
        if (token !== watchToken) break;
        await checkHealth().catch((e) => log(`watch: ${e?.message ?? e}`));
      }
    })();
  }
  function stopWatch() { watchToken++; }

  /** One watch step: probe the API, and on failure tell a crash from a hang. */
  async function checkHealth() {
    if (state !== 'ready') return;
    const gen = generation;
    if ((await probe(`http://${bind}:${ports.api}/health`)) === 200) {
      watchFailures = 0;
      if (gpuChecked && !(await gpuStillUsed(gen))) return;
      const sideCrash = (await crashedOrNull('cp', names.cp)) ?? (relayLinked ? await crashedOrNull('relay', names.relay) : null);
      if (sideCrash && gen === generation) { stopWatch(); set('error', sideCrash.toJSON()); }
      return;
    }
    const crashed = await crashedOrNull('api', names.api);
    if (gen !== generation) return;
    if (crashed) { stopWatch(); set('error', crashed.toJSON()); await inspectContainers(); return; }
    if (++watchFailures >= T.watchFailures) {
      stopWatch();
      set('error', new AppError('UNHEALTHY', { role: 'api', url: `http://${bind}:${ports.api}/health`, tail: await containerTail(names.api) }).toJSON());
    }
  }

  /**
   * GPU compute's watch step: an API that Docker restarted (a new StartedAt) is checked again,
   * since a lost GPU brings it back on the CPU. False when it failed (the API is then stopped).
   */
  async function gpuStillUsed(gen) {
    const c = await docker.inspectContainer(names.api);
    const startedAt = c?.State?.StartedAt ?? null;
    if (!startedAt || startedAt === gpuChecked.startedAt) return true;
    const { settings } = currentSettings();
    try {
      const read = await readDevices();
      assertOnCuda(read.devices, settings);
      if (gen === generation) gpuChecked = read;
      return true;
    } catch (e) {
      if (gen !== generation) return false;
      stopWatch();
      gpuChecked = null;
      await stopApiQuietly();
      set('error', toAppError(e, 'DOCKER_FAILED', { command: 'logs' }).toJSON());
      await inspectContainers();
      return false;
    }
  }

  /**
   * Whether the relay container may be running: this process linked it, or it is ours and
   * running, whichever process started it. Inspecting needs a resolved docker (a shutdown
   * must not wait on a resolve), so an unresolved docker counts only this process's own link.
   * The inspect is bounded (`shutdownProbeMs`): a clean "missing", "not ours" or "not running"
   * answer is no; anything else (a timeout, a docker error, unreadable output) is yes, since
   * `docker stop` of a missing name only errors for that name.
   */
  async function relayMayRun() {
    if (relayLinked) return true;
    if (!docker.info().mode) return false;
    try {
      const r = await docker.exec(['container', 'inspect', names.relay], { check: false, timeoutMs: T.shutdownProbeMs });
      if (r.code !== 0) return !/No such|not found/i.test(r.stderr);
      const c = JSON.parse(r.stdout)[0];
      return !!c && c.Config?.Labels?.[LABELS.owner] === owner && !!(c.State?.Running || c.State?.Restarting);
    } catch { return true; }
  }

  async function stopContainersNow() {
    const present = [];
    for (const n of [names.relay, names.cp, names.api]) {
      const c = await docker.inspectContainer(n);
      if (c && c.Config?.Labels?.[LABELS.owner] === owner && (c.State?.Running || c.State?.Restarting)) present.push(n);
    }
    if (present.length) await docker.stopContainers(present, T.stopSeconds);
  }

  return {
    /** Start Hindsight (or re-check after a fix). Never throws; the outcome is in `status()`. */
    ensureRunning() {
      wantRunning = true;
      // Shown at once, so a Start answered before the queue reaches it does not read "stopped".
      if (state === 'stopped' || state === 'error') set('checking');
      return serial(runBringUp);
    },

    /** Stop the containers (kept, with the volume). */
    stop() {
      wantRunning = false;
      generation++;
      gpuChecked = null;
      stopWatch();
      relay.stop();
      relayLinked = false;
      return serial(async () => {
        set('stopping');
        try {
          await docker.resolve();
          await stopContainersNow();
          cpSession.clear();
          set('stopped');
          await inspectContainers();
        } catch (e) {
          set('error', toAppError(e, 'DOCKER_FAILED', { command: 'stop' }).toJSON());
        }
      });
    },

    /** Stop, then start again (a crashed or hung container gets a fresh start). */
    restart() {
      wantRunning = true;
      generation++;
      stopWatch();
      relay.stop();
      relayLinked = false;
      return serial(async () => {
        try {
          await docker.resolve();
          set('stopping');
          await stopContainersNow();
        } catch (e) {
          set('error', toAppError(e, 'DOCKER_FAILED', { command: 'stop' }).toJSON());
          return;
        }
        await runBringUp();
      });
    },

    /** After a job fixed a precondition (an image arrived): start again if the user wants it running. */
    afterPrecondition() {
      if (wantRunning && state === 'error') return this.ensureRunning();
      return serial(async () => { if (docker.info().mode) await this.refresh(); });
    },

    /** Re-read images and containers for the Status page. */
    async refresh() {
      try {
        await docker.resolve();
        const { settings } = currentSettings();
        await inspectImages(settings.variant);
        await inspectContainers();
      } catch (e) {
        if (state === 'stopped' || state === 'error') set('error', toAppError(e, 'DOCKER_FAILED', { command: 'inspect' }).toJSON());
      }
    },

    checkHealth,

    /**
     * cc is stopping the backend (SIGTERM; SIGKILL follows within its grace period). Stop the
     * containers from a detached process so Postgres shuts down cleanly after we are gone, and
     * record it so the next backend waits before reconciling.
     */
    async shutdown() {
      generation++;
      stopWatch();
      relay.stop();
      let pid;
      try {
        pid = await docker.stopDetached([names.cp, names.api, ...((await relayMayRun()) ? [names.relay] : [])], T.stopSeconds);
      } catch (e) {
        // No pid to wait for: record the failure instead of a stopping.json the next backend
        // would read as "a stop is under way".
        const detail = e?.message ?? String(e);
        log(`shutdown: could not stop the containers: ${detail}`);
        writePrivateFileAtomic(shutdownFailedFile, JSON.stringify({ at: new Date(clock.now()).toISOString(), error: detail }));
        return null;
      }
      writePrivateFileAtomic(stoppingFile, JSON.stringify({ pid, at: clock.now() }));
      return pid;
    },

    status() {
      const { settings } = currentSettings();
      const autoBind = settings.network.bindAddress === null;
      return {
        state,
        error,
        docker: docker.info(),
        variant: settings.variant,
        bindAddress: bind ?? (autoBind ? detectBind() : settings.network.bindAddress),
        bindAuto: autoBind,
        ports: ports ?? { api: settings.network.apiPort, cp: settings.network.cpPort, relay: settings.network.relayPort },
        images,
        containers,
        startedAt: state === 'ready' ? startedAt : null,
        pendingRestart: state === 'ready' && appliedKey !== null && appliedKeyOf(settings) !== appliedKey,
        volume: names.volume,
        lastShutdownFailure,
        llmMode: settings.llm.mode,
        /** `devices`: what the running API's local models loaded on, once a GPU start was checked. */
        compute: { mode: settings.compute, devices: gpuChecked?.devices ?? null },
        relay: relayLinked ? relay.status() : null,
      };
    },

    /** The CP's address while ready (the proxy's target), else null. */
    cpTarget: () => (state === 'ready' ? { host: bind, port: ports.cp } : null),
    /** The CP's address once a start has resolved it (the session signs in before ready). */
    cpAddress: () => (bind && ports ? { host: bind, port: ports.cp } : null),
    notReadyError: () => error ?? describeError('NOT_READY'),

    /** Where Hindsight's API is and the key it takes (for clients such as Claude Code hooks). */
    connection() {
      if (state !== 'ready') return null;
      return { apiUrl: `http://${bind}:${ports.api}`, apiKey: secretsStore.get().apiKey };
    },
  };
}
