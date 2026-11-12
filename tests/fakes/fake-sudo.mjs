#!/usr/bin/env node
// A fake `sudo` for tests: honours only `-n <cmd> args…`.
//   FAKE_SUDO_MODE=ok (default) runs the command with FAKE_DOCKER_VIA_SUDO=1
//   FAKE_SUDO_MODE=password fails as `sudo -n` does when a password would be needed
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [flag, cmd, ...rest] = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify({ sudo: [flag, cmd, ...rest] })}\n`);
if (flag !== '-n') { process.stderr.write('fake sudo: only -n is supported\n'); process.exit(2); }
if (process.env.FAKE_SUDO_MODE === 'password') { process.stderr.write('sudo: a password is required\n'); process.exit(1); }
const r = spawnSync(cmd, rest, { stdio: 'inherit', env: { ...process.env, FAKE_DOCKER_VIA_SUDO: '1' } });
process.exit(r.status ?? 1);
