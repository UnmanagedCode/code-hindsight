// The one place the Hindsight release, its images and the plugin's mount point are pinned.
// Bumping Hindsight: change the version, tag, revision and image IDs here, rebuild the CP
// image (Images & data → Build CP image), and pull or import the matching API images.
//
// Image IDs: an image is trusted by its ID, never by its tag or labels (both forgeable by a
// `docker load`). Docker reports `.Id` as the index digest under the containerd image store
// and as the per-platform config digest under the classic store, so each pinned image lists
// both forms (index; linux/amd64 and linux/arm64 config digests).

export const HINDSIGHT_VERSION = '1.2.1';
export const UPSTREAM_REPO = 'https://github.com/vectorize-io/hindsight.git';
/** The commit upstream's release tag (v1.2.1) points at; the CP is built from it, and the official images carry it as `org.opencontainers.image.revision`. */
export const UPSTREAM_REVISION = '0eb02d8c418eac6b489bc63883c993b2257dfac4';

/** The official API images per variant: the tag pulled, its version label (shown), and the IDs accepted. */
export const API_IMAGES = Object.freeze({
  full: Object.freeze({
    ref: 'ghcr.io/vectorize-io/hindsight:1.2.1',
    version: '1.2.1',
    ids: Object.freeze([
      'sha256:d2bc230a714e933affd63753e181a0579328fdcbbc021800a76e0bc7b6e76b31',
      'sha256:3d70fca8c401371a518824e6c0f776ec943b063c7963639207e55bd57e9bea67',
      'sha256:c304f8339b8df29e5e01ff1367a1bd07fe308a6f21b7bc761892e551da5c2b6d',
    ]),
  }),
  slim: Object.freeze({
    ref: 'ghcr.io/vectorize-io/hindsight:1.2.1-slim',
    version: '1.2.1-slim',
    ids: Object.freeze([
      'sha256:5ad59a5e8ea1a7424376ad0f0fa149cf42f30e36a944b71b6e40cc23230dd04a',
      'sha256:9f107f626d993685b8a976e57e28aa0ead5885f8d48da2dd242d818d77583778',
      'sha256:1773fc14d767b97c3927589eee49b3ba82bcd465ce5bf3e18a0487dd015bcb1c',
    ]),
  }),
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
 * It gets the Docker socket, so it is resolved by digest and run by a verified ID only.
 */
export const BUILD_HELPER = Object.freeze({
  /** docker:29.9.2-cli, by digest: what the build job pulls when it is missing. */
  ref: 'docker@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb',
  ids: Object.freeze([
    'sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb',
    'sha256:7691a001d1bf70d960395ef367f9f008db5f8d7d18556b2b88303596a4384d51',
    'sha256:91b36450843da1d4e9477dd07f20e63bfbcfaba25ca79664ac154ae82fae0f67',
  ]),
});

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
/** Where the API image keeps its embedded Postgres data. */
export const API_DATA_PATH = '/home/hindsight/.pg0';
/** The CP session cookie (`ACCESS_KEY_COOKIE` upstream). */
export const CP_COOKIE = 'hindsight_cp_access';
