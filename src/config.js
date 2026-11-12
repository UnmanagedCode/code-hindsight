// Process configuration from the environment cc gives a plugin backend.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig(env = process.env) {
  const dataDir = env.CONDUCTOR_PLUGIN_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw new Error('CONDUCTOR_PLUGIN_DATA_DIR must be set to an absolute path (cc sets it; standalone, set it yourself)');
  }
  const port = env.PORT === undefined || env.PORT === '' ? 0 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  return {
    port,
    dataDir,
    conductorUrl: env.CONDUCTOR_URL || null,
    pluginId: env.CONDUCTOR_PLUGIN_ID || 'code-hindsight',
    distDir: path.join(root, 'frontend', 'dist'),
  };
}
