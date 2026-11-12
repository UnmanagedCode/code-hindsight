// A stand-in for cc's plugin proxy, for tests that must not touch a live cc. It reproduces the
// behaviours this plugin depends on (cc's docs/plugins.md → Reverse proxy):
//   - `/plugins/<id>/x?q` → backend `/x?q`, with X-Forwarded-Prefix/Host/Proto/For;
//   - `/plugins/<id>` → 301 `/plugins/<id>/`;
//   - every root-relative Location from the backend gets the prefix added (even one that
//     already carries it);
//   - X-Frame-Options: SAMEORIGIN when the backend sends no framing policy.
// Every other path is cc's own: it answers 404 and is recorded in `leaks`.
import http from 'node:http';

export async function startCcFront({ pluginId, backendPort, host = '127.0.0.1' }) {
  const prefix = `/plugins/${pluginId}`;
  const requests = [];
  const leaks = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === prefix || req.url.startsWith(`${prefix}?`)) {
      res.writeHead(301, { location: `${prefix}/${req.url.slice(prefix.length)}` });
      return res.end();
    }
    if (!req.url.startsWith(`${prefix}/`)) {
      leaks.push({ method: req.method, url: req.url });
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found (cc root)' }));
    }
    const headers = { ...req.headers, 'x-forwarded-prefix': prefix, 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': 'http', 'x-forwarded-for': req.socket.remoteAddress ?? '' };
    const up = http.request({ host: '127.0.0.1', port: backendPort, method: req.method, path: req.url.slice(prefix.length), headers }, (r) => {
      const out = { ...r.headers };
      if (typeof out.location === 'string' && out.location.startsWith('/')) out.location = prefix + out.location;
      const framing = /^(deny|sameorigin)$/i.test(String(out['x-frame-options'] ?? '').trim()) || /frame-ancestors/.test(String(out['content-security-policy'] ?? ''));
      if (!framing) out['x-frame-options'] = 'SAMEORIGIN';
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, host, r));
  const port = server.address().port;
  return {
    port,
    origin: `http://${host}:${port}`,
    prefix,
    requests,
    leaks,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
