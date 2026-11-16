// Which images may run. The pinned tags (pins.js): the API image runs when its tag is present,
// and the CP and GPU images must also carry this plugin's build labels. Nothing is trusted or refused
// by image ID.
import { BASE_PATH, GPU_TORCH_FLAVOR, LABELS, UPSTREAM_TAG } from './pins.js';
import { GPU_RECIPE_PATH } from './gpuRecipe.js';

/** True when the image carries the labels of a CP build for this plugin's base path and upstream release tag. */
export const isOurCpBuild = (image) =>
  !!image &&
  image.Config?.Labels?.[LABELS.basePath] === BASE_PATH &&
  image.Config?.Labels?.[LABELS.upstream] === UPSTREAM_TAG;

/** True when the image carries the labels of a GPU build from this plugin's recipe, upstream release tag and torch flavour. */
export const isOurGpuBuild = (image) =>
  !!image &&
  image.Config?.Labels?.[LABELS.recipe] === GPU_RECIPE_PATH &&
  image.Config?.Labels?.[LABELS.upstream] === UPSTREAM_TAG &&
  image.Config?.Labels?.[LABELS.cuda] === GPU_TORCH_FLAVOR;
