// Response helpers for the plugin's own routes: the security headers every response carries,
// JSON replies, and the allowlisted static UI from frontend/dist.
import fs from 'node:fs';
import path from 'node:path';

/** The plugin page's policy. `frame-src 'self'` admits the nested control-plane frame. */
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

export function securityHeaders() {
  return { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' };
}

export function sendJson(res, status, body) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, text) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', woff2: 'font/woff2' };
// A name that starts with a letter or digit, one of these extensions, at the dist root or under assets/.
// `.map`, dotfiles and `.vite/` cannot match.
const ASSET_RE = /^\/((?:assets\/)?[A-Za-z0-9][A-Za-z0-9_.-]*\.(html|js|css|svg|png|ico|woff2))$/;

/**
 * Serve `/` (index.html) and allowlisted dist files. Returns false when the path is not a UI
 * path, so the caller can route it elsewhere. While the UI is unbuilt, HTML entry pages answer
 * 503 and other UI paths 404.
 */
export function serveStatic(req, res, pathname, distDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let p;
  try { p = decodeURIComponent(pathname); } catch { return false; }
  const m = p === '/' ? [p, 'index.html', 'html'] : ASSET_RE.exec(p);
  if (!m || m[1].includes('..') || /\.map$/.test(m[1])) return false;
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) {
    if (m[2] !== 'html') return false;
    console.error(`code-hindsight: UI not built: ${index} is missing — run npm install`);
    sendText(res, 503, 'UI not built — run npm install in the plugin checkout');
    return true;
  }
  let file;
  try {
    const root = fs.realpathSync(distDir);
    file = fs.realpathSync(path.join(root, m[1]));
    if (!file.startsWith(root + path.sep)) return false;
  } catch {
    return false;
  }
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': TYPES[m[2]],
    'cache-control': m[1].startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}

/** Read a JSON request body (bounded). */
export async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
