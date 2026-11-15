// Gated (RUN_REAL_DOCKER=1, a browser and a built frontend/dist): the Memory tab's scope editor in
// a real Chromium, inside a cc-style frame (tests/support/ccFront.mjs). Needs no Hindsight and no
// Docker (the fake docker is used) and never reaches a live cc.
// Browser: CODE_HINDSIGHT_CDP_URL (connectOverCDP) or CODE_HINDSIGHT_CHROMIUM (launched headless).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, REPO } from './helpers.mjs';
import { startFakeCc } from './support/fakeCc.mjs';
import { startCcFront } from './support/ccFront.mjs';
import { REAL } from './support/realStack.mjs';

const cdp = process.env.CODE_HINDSIGHT_CDP_URL;
const chromium = process.env.CODE_HINDSIGHT_CHROMIUM;
const dist = path.join(REPO, 'frontend', 'dist');
const skip = !REAL ? 'set RUN_REAL_DOCKER=1 to run the browser tests'
  : !cdp && !chromium ? 'set CODE_HINDSIGHT_CDP_URL or CODE_HINDSIGHT_CHROMIUM to drive a browser'
    : !fs.existsSync(path.join(dist, 'index.html')) ? 'frontend/dist is not built (npm run prepare)'
      : false;

const scope = (name, match = {}) => ({ name, match, bank: 'cc-{project}', actions: ['recall', 'retain'] });
const rect = (b) => ({ left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height, width: b.width });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('scope editor in a real browser: collapse, anchored suggestions, keyboard', { skip, timeout: 120_000 }, async (t) => {
  const fakeCc = await startFakeCc(t, { projects: ['code-hindsight', 'code-wiki', 'notes', 'core-lib'].map((name, i) => ({ name, workspace: i < 2 ? 'CC-Dev' : null })) });
  fakeCc.setWorkspaces([{ name: 'CC-Dev', projectCount: 2 }, { name: 'Core', projectCount: 0 }, { name: 'HOME', projectCount: 0 }]);
  const { url, r } = await boot(t, { cc: fakeCc.url, distDir: dist, start: false });
  fs.mkdirSync(r.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(r.dataDir, 'scopes.json'), JSON.stringify({ scopes: [scope('alpha', { projects: ['code-*'] }), scope('beta')] }), { mode: 0o600 });
  const front = await startCcFront({ pluginId: 'code-hindsight', backendPort: Number(new URL(url).port) });
  t.after(() => front.close());
  const { chromium: pw } = await import('playwright-core');
  const browser = cdp ? await pw.connectOverCDP(cdp) : await pw.launch({ executablePath: chromium });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  const plugin = `${front.prefix}/?view=memory`;

  /** The scope editor in `root` (the cc frame, or the page itself) with scope 0 expanded and its Workspaces input focused. */
  async function openWorkspaces(root) {
    const card = root.locator('[data-scope="0"]');
    await card.locator('button[aria-expanded]').first().waitFor();
    await card.locator('button[aria-expanded]').first().click();
    const input = card.getByRole('combobox').nth(1);
    await input.click();
    await input.fill('c');
    return { card, input, list: card.locator('[role=listbox]:not([hidden])').nth(0) };
  }
  async function checkAnchored(root) {
    const { card, input, list } = await openWorkspaces(root);
    const listBox = await list.waitFor().then(() => list.boundingBox());
    const inputBox = rect(await input.boundingBox());
    const l = rect(listBox);
    // spec 4: under the input, same left edge and width, and clear of the Add button.
    assert.ok(Math.abs(l.left - inputBox.left) <= 1, `left ${l.left} vs ${inputBox.left}`);
    assert.ok(Math.abs(l.width - inputBox.width) <= 1, `width ${l.width} vs ${inputBox.width}`);
    const gap = l.top - inputBox.bottom;
    assert.ok(gap >= 0 && gap <= 8, `gap ${gap}`);
    const add = rect(await card.getByRole('button', { name: 'Add workspace' }).boundingBox());
    assert.equal(overlaps(l, add), false, 'listbox overlaps the Add workspace button');
    assert.equal(await root.locator('datalist').count(), 0);
    return { card, input };
  }

  // spec 1: seeded scopes start collapsed; the toggle shows and hides the body.
  await page.goto(`${front.origin}/__host?src=${plugin}`, { waitUntil: 'networkidle' });
  const frame = page.frameLocator('iframe[data-plugin-frame]');
  const first = frame.locator('[data-scope="0"]');
  const toggle = first.locator('button[aria-expanded]').first();
  await toggle.waitFor();
  const body = frame.locator(`#${await toggle.getAttribute('aria-controls')}`);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await body.isVisible(), false);
  assert.match(await toggle.innerText(), /alpha/);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await body.isVisible(), true);
  await toggle.click();
  assert.equal(await body.isVisible(), false);

  // spec 4 in cc's frame, then spec 2 keyboard on the same input.
  const { card, input } = await checkAnchored(frame);
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.equal(await card.locator('[data-workspace]').count(), 1);
  await input.fill('c');
  await frame.locator('[data-scope="0"] [role=listbox]:not([hidden])').first().waitFor();
  await input.press('Escape');
  assert.equal(await frame.locator('[data-scope="0"] [role=listbox]:not([hidden])').count(), 0);

  // spec 4 at a phone width, loading the plugin page directly.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${front.origin}${plugin}`, { waitUntil: 'networkidle' });
  await checkAnchored(page);
});
