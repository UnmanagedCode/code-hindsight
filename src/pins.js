// The one place the Hindsight release, its images and the plugin's mount point are pinned.
// Bumping Hindsight: change the version, tags and revision here, rebuild the CP image
// (Images & data → Build CP image), and pull or import the matching API images.
//
// Images are pinned by tag, never by digest: the tag is the pin.

export const HINDSIGHT_VERSION = '1.2.1';
export const UPSTREAM_REPO = 'https://github.com/vectorize-io/hindsight.git';
/** The commit upstream's release tag (v1.2.1) points at; the CP is built from it, and the official images carry it as `org.opencontainers.image.revision`. */
export const UPSTREAM_REVISION = '0eb02d8c418eac6b489bc63883c993b2257dfac4';

/** The official API images per variant: the tag pulled and run. */
export const API_IMAGES = Object.freeze({
  full: Object.freeze({ ref: 'ghcr.io/vectorize-io/hindsight:1.2.1' }),
  slim: Object.freeze({ ref: 'ghcr.io/vectorize-io/hindsight:1.2.1-slim' }),
});
export const VARIANTS = Object.freeze(Object.keys(API_IMAGES));

/** The cc mount point; the CP image is built with it as `NEXT_PUBLIC_BASE_PATH`. */
export const BASE_PATH = '/plugins/code-hindsight';

/** The control-plane image this plugin builds from the upstream source. */
export const CP_IMAGE = 'code-hindsight-cp:1.2.1';
export const CP_DOCKERFILE = 'docker/standalone/Dockerfile';
export const CP_TARGET = 'cp-only';
/**
 * The docker CLI image the CP build runs in (it carries buildx, which the host CLI may lack).
 * It gets the Docker socket, so it is the only image `runHelper` will run; keep it at or below
 * the daemon's API version.
 */
export const BUILD_HELPER = 'docker:29.9.2-cli';

/** Every container, volume and network this plugin creates is named `<RESOURCE_PREFIX>-…`. */
export const RESOURCE_PREFIX = 'code-hindsight';

/** Label keys on everything this plugin creates. */
export const LABELS = Object.freeze({
  managed: 'io.code-hindsight.managed',
  owner: 'io.code-hindsight.owner',
  role: 'io.code-hindsight.role',
  spec: 'io.code-hindsight.spec',
  embeddings: 'io.code-hindsight.embeddings',
  basePath: 'io.code-hindsight.basePath',
  upstream: 'io.code-hindsight.upstream',
});

/** Ports the upstream images listen on inside their containers. */
export const API_CONTAINER_PORT = 8888;
export const CP_CONTAINER_PORT = 9999;
/**
 * The relay: a container on the plugin network that a client in the API container calls, and the
 * one port the plugin dials out to (the tunnel). What the API calls is the relay's target.
 */
export const RELAY_TUNNEL_PORT = 7070;
/**
 * The relay's targets, by kind. Only one is active at a time. `alias` and `apiPort` are where
 * the API's LLM client finds the relay; `allowed` is every `METHOD path` the plugin forwards
 * (model management is never among them); `keyHeader` is where that client puts the relay key
 * (`authorization`: `Bearer <key>`; `x-api-key`: the raw value). These are facts about the
 * pinned upstream's providers: re-check them when bumping Hindsight.
 */
export const RELAY_TARGETS = Object.freeze({
  ollama: Object.freeze({
    alias: 'ollama',
    apiPort: 11434,
    allowed: Object.freeze(['POST /v1/chat/completions', 'POST /api/chat']),
    keyHeader: 'authorization',
  }),
  'anthropic-loopback': Object.freeze({
    alias: 'cc-backend',
    apiPort: 8080,
    allowed: Object.freeze(['POST /v1/messages']),
    keyHeader: 'x-api-key',
  }),
});
/** Where the API image keeps its embedded Postgres data. */
export const API_DATA_PATH = '/home/hindsight/.pg0';
/** The CP session cookie (`ACCESS_KEY_COOKIE` upstream). */
export const CP_COOKIE = 'hindsight_cp_access';
