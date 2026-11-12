// The control-plane-under-basePath checks, run in a real Chromium against a cc-style front
// (tests/support/ccFront.mjs) that proxies to this plugin's CP proxy. Shared by the gated
// browser test; each check returns evidence and throws on failure.
import assert from 'node:assert/strict';

/** Root paths the CP requests without its base path (upstream raw URLs, a documented limitation). */
export const KNOWN_ROOT_LEAKS = [/^\/favicon\.(png|ico)$/, /^\/logo\.png$/, /^\/v1\/[^/]+\/banks\/[^/]+\/attachments\//];

const isKnownLeak = (p) => KNOWN_ROOT_LEAKS.some((re) => re.test(p));

/**
 * @param {object} o
 * @param {import('playwright-core').Browser} o.browser
 * @param {{origin: string, prefix: string, leaks: {url: string}[]}} o.front
 * @param {string} o.bankId a bank that exists, with at least one memory
 * @param {() => void} o.poisonSession make the proxy's next CP request carry a rejected session
 * @param {() => number} o.relogins how many times the proxy has signed in so far
 */
export async function runBasePathChecks({ browser, front, bankId, poisonSession, relogins }) {
  const evidence = { steps: [], requests: [], failures: [] };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('request', (r) => evidence.requests.push(new URL(r.url()).pathname));
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.status() >= 400 && !isKnownLeak(p)) evidence.failures.push(`${r.status()} ${p}`);
  });
  const at = (p) => `${front.origin}${front.prefix}${p}`;
  const step = (name, detail) => evidence.steps.push({ name, ...detail });

  try {
    // 1. The dashboard loads under the prefix and lists the bank (fetched through the proxy).
    await page.goto(at('/dashboard'), { waitUntil: 'networkidle' });
    await page.getByText(bankId, { exact: true }).first().waitFor({ timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, `${front.prefix}/dashboard`);
    assert.ok(evidence.requests.includes(`${front.prefix}/api/banks`), 'bank list fetched under the prefix');
    step('dashboard', { url: new URL(page.url()).pathname });

    // 2. Client-side navigation into a bank stays under the prefix.
    await page.getByText(bankId, { exact: true }).first().click();
    await page.waitForURL((u) => u.pathname.startsWith(`${front.prefix}/banks/`), { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    step('bank', { url: new URL(page.url()).pathname });

    // 3. Back returns to the dashboard.
    await page.goBack({ waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, `${front.prefix}/dashboard`);
    await page.getByText(bankId, { exact: true }).first().waitFor({ timeout: 15_000 });
    step('back', { url: new URL(page.url()).pathname });

    // 4. A rejected session is recovered by the proxy: a full page load and the API both work.
    const before = relogins();
    poisonSession();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText(bankId, { exact: true }).first().waitFor({ timeout: 15_000 });
    assert.equal(new URL(page.url()).pathname, `${front.prefix}/dashboard`);
    assert.ok(relogins() > before, 'the proxy signed in again');
    step('relogin-page', { url: new URL(page.url()).pathname, relogins: relogins() - before });

    const before2 = relogins();
    poisonSession();
    const api = await page.evaluate(async () => { const r = await fetch('api/banks'); return { status: r.status, body: await r.text() }; });
    assert.equal(api.status, 200);
    assert.ok(api.body.includes(bankId));
    assert.ok(relogins() > before2, 'the proxy signed in again for the API call');
    step('relogin-api', { status: api.status });

    // 5. Redirects land inside the prefix exactly once.
    const loginRedirect = await page.evaluate(async () => {
      const r = await fetch('login?returnTo=%2Fdashboard', { redirect: 'manual' });
      return { type: r.type, status: r.status };
    });
    const viaNode = await fetch(at('/login?returnTo=%2Fbanks%2Fx'), { redirect: 'manual' });
    assert.equal(viaNode.status, 302);
    assert.equal(viaNode.headers.get('location'), `${front.prefix}/banks/x`);
    const slash = await fetch(at('/dashboard/'), { redirect: 'manual' });
    const slashLoc = slash.headers.get('location');
    assert.ok(slash.status >= 300 && slash.status < 400, `trailing-slash redirect, got ${slash.status}`);
    assert.equal(new URL(slashLoc, front.origin).pathname, `${front.prefix}/dashboard`);
    step('redirects', { login: viaNode.headers.get('location'), trailingSlash: slashLoc, browserLogin: loginRedirect });

    // 6. The CP's sign-out is answered by the proxy; the UI stays usable under the prefix.
    await page.goto(at('/dashboard'), { waitUntil: 'networkidle' });
    const logout = await page.evaluate(async () => (await fetch('api/auth/logout', { method: 'POST' })).status);
    assert.equal(logout, 200);
    await page.goto(at('/login'), { waitUntil: 'networkidle' });
    assert.equal(new URL(page.url()).pathname, `${front.prefix}/dashboard`);
    await page.getByText(bankId, { exact: true }).first().waitFor({ timeout: 15_000 });
    step('logout-login', { url: new URL(page.url()).pathname });

    // 7. The browser never holds the CP session cookie.
    const cookies = await ctx.cookies();
    assert.equal(cookies.some((c) => c.name === 'hindsight_cp_access'), false);
    step('cookies', { names: cookies.map((c) => `${c.name}@${c.path}`) });
  } finally {
    await ctx.close();
  }

  const rootRequests = [...new Set(evidence.requests.filter((p) => !p.startsWith(`${front.prefix}/`) && p !== front.prefix))];
  evidence.rootRequests = rootRequests;
  evidence.unknownLeaks = rootRequests.filter((p) => !isKnownLeak(p) && p !== '/pluginBridge.js' && p !== '/pluginTheme.css');
  evidence.frontLeaks = front.leaks.map((l) => l.url);
  assert.deepEqual(evidence.unknownLeaks, [], 'requests outside the prefix beyond the known gap');
  assert.deepEqual(evidence.failures, [], 'failed requests under the prefix');
  return evidence;
}
