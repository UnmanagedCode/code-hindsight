// Source-scan guards over the UI: no HTML-string sinks, relative URLs only (except the two host
// URLs), no inline script or style in index.html, the host contract's <head> order, no
// parent-page scripting, and no shipped source maps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const FRONTEND = path.join(REPO, 'frontend');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const files = [path.join(FRONTEND, 'index.html'), ...walk(path.join(FRONTEND, 'src')), ...walk(path.join(FRONTEND, 'public'))]
  .filter((f) => /\.(tsx?|html|js|css)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes(`${path.sep}test${path.sep}`))
  .map((f) => [path.relative(FRONTEND, f), fs.readFileSync(f, 'utf8')]);
const html = files.find(([n]) => n === 'index.html')[1];

// Invariant: model-, Docker- or Hindsight-written text is never markup; no eval; no scripting of cc's page.
test('the UI has no HTML-string sinks, eval, hash writes, window.parent or cc storage keys', () => {
  const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|dangerouslySetInnerHTML|location\.hash\s*=|window\.parent|window\.top|code-conductor:/;
  assert.ok(files.length > 10, 'scanned the UI sources');
  for (const [n, src] of files) assert.equal(banned.test(src), false, `${n}: ${src.match(banned)?.[0]}`);
});

// Invariant: every URL is relative (cc mounts the page under /plugins/code-hindsight/), except the two host URLs.
test('the UI uses no root-relative URLs besides the host bridge and theme', () => {
  const rootRel = /(?:src|href)\s*=\s*["'`{]\s*["'`]?\/(?!\/)|['"`]\/-\/api|fetch\(\s*['"`]\/|api(?:<[^>]*>)?\(\s*['"`]\//g;
  for (const [n, src] of files) {
    for (const m of src.matchAll(rootRel)) {
      const at = src.slice(m.index, m.index + 40);
      assert.ok(n === 'index.html' && /^(src="\/pluginBridge\.js"|href="\/pluginTheme\.css")/.test(at), `${n}: ${at}`);
    }
  }
});

test('index.html: bridge first and blocking, then the theme, theme-init, the module entry; no inline script or style', () => {
  const tags = [...html.matchAll(/<(script|link)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: m[2] }));
  const order = tags.filter((t) => t.tag === 'script' || /rel="stylesheet"/.test(t.attrs)).map((t) => t.attrs.match(/(?:src|href)="([^"]+)"/)[1]);
  assert.deepEqual(order, ['/pluginBridge.js', '/pluginTheme.css', 'theme-init.js', './src/main.tsx']);
  assert.doesNotMatch(tags[0].attrs, /\b(?:defer|async|type="module")\b/);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'inline <script>');
  assert.equal(/<style[\s>]|\sstyle\s*=/.test(html), false, 'inline style');
  assert.match(html, /<title>Code Hindsight<\/title>/);
});

test('the built UI ships no source maps and no absolute URL in its CSS', { skip: !fs.existsSync(path.join(FRONTEND, 'dist', 'index.html')) && 'frontend/dist not built' }, () => {
  const dist = walk(path.join(FRONTEND, 'dist'));
  assert.deepEqual(dist.filter((f) => f.endsWith('.map')), []);
  for (const f of dist.filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/https?:\/\/|url\(\/\//.test(css), false, f);
  }
});
