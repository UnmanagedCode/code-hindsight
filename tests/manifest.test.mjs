// conductor.plugin.json: the id, the backend start and the health path the backend serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, boot } from './helpers.mjs';
import { BASE_PATH } from '../src/pins.js';

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'conductor.plugin.json'), 'utf8'));

test('the manifest id is the one the CP image is built for; the frontend sits at the root', () => {
  assert.equal(manifest.id, 'code-hindsight');
  assert.equal(`/plugins/${manifest.id}`, BASE_PATH);
  assert.equal(manifest.pluginApi, 1);
  assert.equal(manifest.backend.start, 'node server.js');
  assert.deepEqual(manifest.frontend, { path: '/', navLabel: 'Code Hindsight' });
  assert.equal(manifest.name, 'Code Hindsight');
});

test('the manifest healthPath answers 200 even when Docker is unusable', async (t) => {
  const { url } = await boot(t, { mode: 'daemon-down' });
  assert.equal((await fetch(url + manifest.backend.healthPath)).status, 200);
});

test('claudePlugin resolves to a Claude Code plugin root that is not cc\'s own', () => {
  const root = path.join(REPO, manifest.claudePlugin);
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.notEqual(plugin.name, 'code-conductor');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'memory', 'SKILL.md')));
});

test('the hooks: recall, an async retain and a clear|compact reset, each timeout above the hook deadline above the recall deadline', async () => {
  const { HOOK_TIMEOUTS, forceExitMs } = await import('../claude/hooks/limits.mjs');
  const { DESCRIBE_TIMEOUT_MS, WORKSPACES_TIMEOUT_MS } = await import('../src/ccSession.js');
  const { MEMORY_LIMITS } = await import('../src/memory.js');
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO, 'claude', 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
  const one = (ev) => { assert.equal(hooks[ev].length, 1); assert.equal(hooks[ev][0].hooks.length, 1); return hooks[ev][0].hooks[0]; };
  assert.equal(one('Stop').async, true, 'Stop must run async so it can neither delay nor continue the turn');
  assert.equal(hooks.SessionStart[0].matcher, 'clear|compact');
  assert.match(one('UserPromptSubmit').command, /hook\.mjs" recall$/);
  assert.match(one('Stop').command, /hook\.mjs" retain$/);
  assert.match(one('SessionStart').command, /hook\.mjs" reset$/);
  const seconds = { recall: one('UserPromptSubmit').timeout, retain: one('Stop').timeout, reset: one('SessionStart').timeout };
  for (const [event, s] of Object.entries(seconds)) assert.ok(s * 1000 > HOOK_TIMEOUTS[event], `${event}: hooks.json timeout must exceed the hook's own deadline`);
  for (const [event, s] of Object.entries(seconds)) assert.ok(s * 1000 > forceExitMs(HOOK_TIMEOUTS[event]), `${event}: hooks.json timeout must exceed the hook process's force-exit timer, or Claude Code kills a hook that would have exited cleanly`);
  assert.ok(MEMORY_LIMITS.recallDeadlineMs < HOOK_TIMEOUTS.recall, 'the backend recall deadline is inside the recall hook deadline');
  assert.ok(DESCRIBE_TIMEOUT_MS + WORKSPACES_TIMEOUT_MS < HOOK_TIMEOUTS.retain, 'resolving a Stop fits inside the retain hook deadline');
});

test('the recall tool\'s backend deadline fits inside cc\'s mcp.timeoutMs, which stays within cc\'s cap', async () => {
  const { MEMORY_LIMITS } = await import('../src/memory.js');
  assert.ok(MEMORY_LIMITS.recallDeadlineMs < manifest.mcp.timeoutMs, 'cc must not abort the recall tool before the backend\'s own deadline answers');
  assert.ok(manifest.mcp.timeoutMs <= 120_000, 'cc clamps mcp.timeoutMs to its MCP_TIMEOUT_CAP; a larger value would be silently lowered');
});

test('the manifest mcp.tools are exactly the tools the backend serves, at the endpoint it serves', async (t) => {
  assert.deepEqual(manifest.mcp.tools.map((x) => x.name), ['recall']);
  const { url } = await boot(t, { start: false });
  const post = (body) => fetch(url + manifest.mcp.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.match((await post({ tool: 'recall', arguments: { query: 'x' }, caller: {} })).code, /NO_SESSION/);
  assert.match((await post({ tool: 'nope', arguments: {}, caller: {} })).error, /unknown tool/);
});
