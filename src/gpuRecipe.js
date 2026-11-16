// The GPU image's recipe: the Dockerfile the build-gpu job feeds the build helper, and the
// value of the image's recipe label (the recipe's repo path, naming what built the image).
import fs from 'node:fs';

export const GPU_RECIPE_PATH = 'src/gpu/Dockerfile';
export const GPU_RECIPE = fs.readFileSync(new URL('./gpu/Dockerfile', import.meta.url), 'utf8');
