// Entry point: configuration → app → listen. Hindsight starts with the backend; SIGTERM
// stops it (see supervisor.shutdown).
import http from 'node:http';
import { loadConfig } from './src/config.js';
import { createApp } from './src/app.js';

const config = loadConfig();
const app = createApp(config);
const server = http.createServer(app.handle);
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src \'none\'\r\nConnection: close\r\n\r\nBad request');
  else socket.destroy();
});
server.listen(config.port, '127.0.0.1', () => {
  console.log(`code-hindsight: listening on http://127.0.0.1:${server.address().port}/`);
  app.supervisor.ensureRunning();
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  try {
    const pid = await app.supervisor.shutdown();
    console.log(`code-hindsight: ${signal}: ${pid ? `stopping Hindsight in the background (pid ${pid})` : 'nothing to stop'}`);
  } catch (e) {
    console.error('code-hindsight: shutdown failed:', e);
  }
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
