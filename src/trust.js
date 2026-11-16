// Which images may run. The pinned tags (pins.js): the API image runs when its tag is present,
// and the CP and GPU images must also carry this plugin's build labels. Nothing is trusted or refused
// by image ID.
import { BASE_PATH, GPU_TORCH_FLAVOR, LABELS, UPSTREAM_REVISION } from './pins.js';

/** True when the image carries the labels of a CP build for this plugin's base path and upstream commit. */
export const isOurCpBuild = (image) =>
  !!image &&
  image.Config?.Labels?.[LABELS.basePath] === BASE_PATH &&
  image.Config?.Labels?.[LABELS.upstream] === UPSTREAM_REVISION;

/** True when the image carries the labels of a GPU build of this plugin's upstream commit and torch flavour. */
export const isOurGpuBuild = (image) =>
  !!image &&
  image.Config?.Labels?.[LABELS.upstream] === UPSTREAM_REVISION &&
  image.Config?.Labels?.[LABELS.cuda] === GPU_TORCH_FLAVOR;
