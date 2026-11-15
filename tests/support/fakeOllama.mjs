// A fake Ollama daemon on 127.0.0.1:<random>. Records every request (with its headers and
// body); answers /api/version, /api/tags (one cloud row with remote_host, one local), and
// canned chat replies on /v1/chat/completions and /api/chat, the latter streamed in chunks.
// `fake.down = true` makes it close every connection unanswered.
import http from 'node:http';

export const TAGS = Object.freeze([
  { model: 'qwen3:4b', name: 'qwen3:4b' },
  { model: 'kimi-k2:cloud', name: 'kimi-k2:cloud', remote_host: 'https://ollama.com:443' },
]);

export async function startFakeOllama(t) {
  const fake = { requests: [], down: false, version: '0.40.13', url: '' };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (fake.down) { req.socket.destroy(); return; }
      const body = Buffer.concat(chunks).toString();
      fake.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/version') return json({ version: fake.version });
      if (req.url === '/api/tags') return json({ models: TAGS });
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { content: 'hel' }, done: false })}\n`);
        setTimeout(() => res.end(`${JSON.stringify({ message: { content: 'lo' }, done: true })}\n`), 5);
        return undefined;
      }
      if (req.url === '/v1/chat/completions') return json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], echo: body });
      res.writeHead(404); res.end('not found');
      return undefined;
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return fake;
}
