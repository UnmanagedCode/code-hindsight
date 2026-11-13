// Run claude/hooks/hook.mjs the way Claude Code does: a process fed the hook input on stdin.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO } from '../helpers.mjs';

export const HOOK = path.join(REPO, 'claude', 'hooks', 'hook.mjs');

/** @returns {Promise<{code: number|null, stdout: string, stderr: string, ms: number}>} */
export function runHook(event, input, env, { stdin = JSON.stringify(input), keepStdinOpen = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('node', [HOOK, event], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    if (keepStdinOpen) child.on('close', () => child.stdin.destroy()); // never ended: the hook itself must give up
    child.stdin.on('error', () => {});
    if (keepStdinOpen) child.stdin.write(stdin);
    else child.stdin.end(stdin);
  });
}
