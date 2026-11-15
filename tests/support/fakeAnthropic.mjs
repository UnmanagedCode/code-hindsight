// A fake Anthropic-compatible endpoint on 127.0.0.1:<random>, standing in for a cc backend's
// router that listens on cc's loopback. Records every request (method, path, headers, body);
// answers POST /v1/messages as streamed SSE chunks and anything else 200. `fake.down = true`
// makes it close every connection unanswered; `fake.notFound = true` answers 404 everywhere.
import http from 'node:http';

export async function startFakeAnthropic(t) {
  const fake = { requests: [], down: false, notFound: false, url: '', port: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (fake.down) { req.socket.destroy(); return; }
      fake.requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (fake.notFound) { res.writeHead(404); res.end('not found'); return; }
      if (req.method === 'POST' && req.url.split('?')[0].endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 5);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.port = server.address().port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return fake;
}
