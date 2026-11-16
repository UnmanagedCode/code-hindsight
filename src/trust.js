// Which images may run. The pinned tags (pins.js): the API image runs when its tag is present,
// and the CP image must also carry this plugin's build labels. Nothing is trusted or refused
// by image ID.
import { BASE_PATH, LABELS, UPSTREAM_REVISION } from './pins.js';

/** True when the image carries the labels of a CP build for this plugin's base path and upstream commit. */
export const isOurCpBuild = (image) =>
  !!image &&
  image.Config?.Labels?.[LABELS.basePath] === BASE_PATH &&
  image.Config?.Labels?.[LABELS.upstream] === UPSTREAM_REVISION;
