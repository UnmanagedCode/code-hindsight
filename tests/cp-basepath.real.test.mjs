// Gated (RUN_REAL_DOCKER=1 and a browser): the control plane under /plugins/code-hindsight in a
// real Chromium, through a cc-style front (tests/support/ccFront.mjs) — never a live cc.
// Browser: CODE_HINDSIGHT_CDP_URL (a Code Browser CDP endpoint, connectOverCDP) or
// CODE_HINDSIGHT_CHROMIUM (a local Chromium/Chrome executable, launched headless).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootRealStack, hindsightApi, realSkipReason } from './support/realStack.mjs';
import { startCcFront } from './support/ccFront.mjs';
import { runBasePathChecks } from './support/cpBasePathChecks.mjs';

const cdp = process.env.CODE_HINDSIGHT_CDP_URL;
const chromium = process.env.CODE_HINDSIGHT_CHROMIUM;
const skip = realSkipReason('full') ?? (!cdp && !chromium ? 'set CODE_HINDSIGHT_CDP_URL or CODE_HINDSIGHT_CHROMIUM to drive a browser' : false);

// Spec 6: the CP UI works at /plugins/code-hindsight/ from the basePath build — fetches,
// redirects and navigation stay under the prefix beyond the documented raw-URL gap.
test('control plane under the cc prefix in a real browser', { skip, timeout: 15 * 60_000 }, async (t) => {
  const { app, url, prefix } = await bootRealStack(t);
  await app.supervisor.ensureRunning();
  assert.equal(app.supervisor.status().state, 'ready', JSON.stringify(app.supervisor.status().error));
  const conn = app.supervisor.connection();
  const bankId = `basepath-${prefix.slice(-6)}`;
  assert.equal((await hindsightApi(conn, 'PUT', `/v1/default/banks/${bankId}`, {})).status, 200);
  assert.equal((await hindsightApi(conn, 'POST', `/v1/default/banks/${bankId}/memories`, { items: [{ content: 'Base path test memory.' }] })).status, 200);

  // Make the proxy's next CP request carry a session the CP rejects, and count re-sign-ins.
  let poisoned = false;
  let relogins = 0;
  const token = app.cpSession.token.bind(app.cpSession);
  const relogin = app.cpSession.relogin.bind(app.cpSession);
  app.cpSession.token = async () => (poisoned ? ((poisoned = false), '1.rejected') : token());
  app.cpSession.relogin = () => { relogins++; return relogin(); };

  const front = await startCcFront({ pluginId: 'code-hindsight', backendPort: Number(new URL(url).port) });
  t.after(() => front.close());
  const { chromium: pw } = await import('playwright-core');
  const browser = cdp ? await pw.connectOverCDP(cdp) : await pw.launch({ executablePath: chromium });
  t.after(() => browser.close());

  const evidence = await runBasePathChecks({ browser, front, bankId, poisonSession: () => { poisoned = true; }, relogins: () => relogins });
  t.diagnostic(`steps: ${evidence.steps.map((s) => s.name).join(', ')}`);
  t.diagnostic(`requests outside the prefix (known gap): ${evidence.rootRequests.join(', ') || 'none'}`);
});
