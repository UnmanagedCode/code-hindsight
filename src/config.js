// Process configuration from the environment cc gives a plugin backend.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** `OLLAMA_HOST` (the ollama CLI's variable) as an http URL: scheme and port defaulted, a wildcard bind address read as loopback. */
export function ollamaUrlFrom(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'http://127.0.0.1:11434';
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); } catch { throw new Error(`OLLAMA_HOST is not a host[:port] or URL: "${raw}"`); }
  if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = '127.0.0.1';
  if (!u.port) u.port = '11434';
  return `${u.protocol}//${u.host}`;
}

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
    /** The Ollama daemon the relay's tunnel reaches (it runs in cc's container). */
    ollamaUrl: ollamaUrlFrom(env.OLLAMA_HOST),
    pluginId: env.CONDUCTOR_PLUGIN_ID || 'code-hindsight',
    distDir: path.join(root, 'frontend', 'dist'),
    /** Where Claude Code keeps session transcripts (its own rule): what the backfill importer scans. */
    claudeProjectsDir: path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
  };
}
