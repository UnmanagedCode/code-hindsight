// config.js: OLLAMA_HOST read the way the ollama CLI reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaUrlFrom, loadConfig } from '../src/config.js';

// C-4: scheme and port defaults, wildcard bind addresses read as loopback, malformed input refused.
test('C-4: ollamaUrlFrom defaults the scheme and port, reads a wildcard host as loopback, and refuses nonsense', () => {
  assert.equal(ollamaUrlFrom(undefined), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrlFrom(''), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrlFrom('10.0.0.5'), 'http://10.0.0.5:11434');
  assert.equal(ollamaUrlFrom('ollama.internal:9000'), 'http://ollama.internal:9000');
  assert.equal(ollamaUrlFrom('https://ollama.example'), 'https://ollama.example:11434');
  assert.equal(ollamaUrlFrom('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(ollamaUrlFrom('0.0.0.0:11500'), 'http://127.0.0.1:11500');
  assert.equal(ollamaUrlFrom('[::]'), 'http://127.0.0.1:11434');
  assert.throws(() => ollamaUrlFrom('http://[::1'), /OLLAMA_HOST/);
  assert.throws(() => ollamaUrlFrom('exa mple:1'), /OLLAMA_HOST/);
});

test('C-4: loadConfig carries ollamaUrl from OLLAMA_HOST', () => {
  assert.equal(loadConfig({ CONDUCTOR_PLUGIN_DATA_DIR: '/tmp/x', OLLAMA_HOST: '127.0.0.1:1234' }).ollamaUrl, 'http://127.0.0.1:1234');
});
