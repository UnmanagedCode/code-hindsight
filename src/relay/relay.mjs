// The relay. Runs inside the pinned API image (`node --input-type=module -e <this file>`),
// so it uses Node builtins only and no import.meta. It pairs each connection from the API's
// client with one idle tunnel the plugin dialled out, and pipes bytes between them.
//
// Tunnel wire protocol: the plugin connects to the tunnel port and sends `HSR1 <key>\n`; a bad
// or late handshake is closed. An accepted socket waits idle. For each API connection the relay
// writes one go byte (0x01) to an idle tunnel, waits for the plugin's one-byte ack (the plugin
// has then taken the socket over: bytes sent earlier could be lost), then pipes both ways.
//
// Env: RELAY_KEY, RELAY_API_PORT, RELAY_TUNNEL_PORT, RELAY_WAIT_MS (how long an API connection
// waits for an idle tunnel), RELAY_HANDSHAKE_MS. It prints one JSON line when listening.
import net from 'node:net';
import crypto from 'node:crypto';

const KEY = process.env.RELAY_KEY ?? '';
const API_PORT = Number(process.env.RELAY_API_PORT ?? 11434);
const TUNNEL_PORT = Number(process.env.RELAY_TUNNEL_PORT ?? 7070);
const WAIT_MS = Number(process.env.RELAY_WAIT_MS ?? 10_000);
const HANDSHAKE_MS = Number(process.env.RELAY_HANDSHAKE_MS ?? 5_000);
const MAX_HANDSHAKE_BYTES = 256;
const MAX_IDLE = 16;
const GO = Buffer.from([1]);

if (!KEY) { console.error('relay: RELAY_KEY is not set'); process.exit(1); }
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const digest = (s) => crypto.createHash('sha256').update(s).digest();
const keyDigest = digest(KEY);
const keyMatches = (candidate) => crypto.timingSafeEqual(digest(candidate), keyDigest);
const noop = () => {};

/** Authenticated sockets waiting for an API connection, and API connections waiting for one. */
const idle = [];
const waiting = [];

function pair(tunnel, api) {
  tunnel.removeListener('data', noop);
  api.pause();
  tunnel.write(GO);
  tunnel.once('data', () => {
    api.pipe(tunnel);
    tunnel.pipe(api);
  });
  const end = () => { api.destroy(); tunnel.destroy(); };
  api.on('close', end);
  tunnel.on('close', end);
}

function offer(tunnel) {
  const w = waiting.shift();
  if (w) { clearTimeout(w.timer); pair(tunnel, w.api); return; }
  if (idle.length >= MAX_IDLE) { tunnel.destroy(); return; }
  idle.push(tunnel);
  tunnel.on('data', noop); // read and discard, so a close is noticed
  tunnel.on('close', () => { const i = idle.indexOf(tunnel); if (i !== -1) idle.splice(i, 1); });
}

const tunnelServer = net.createServer((socket) => {
  socket.setKeepAlive(true, 15_000);
  socket.on('error', noop);
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => { console.log('relay: tunnel handshake timed out'); socket.destroy(); }, HANDSHAKE_MS);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      if (buf.length > MAX_HANDSHAKE_BYTES) { clearTimeout(timer); console.log('relay: tunnel handshake too long'); socket.destroy(); }
      return;
    }
    clearTimeout(timer);
    socket.removeListener('data', onData);
    const line = buf.subarray(0, nl).toString('latin1');
    if (nl > MAX_HANDSHAKE_BYTES || !line.startsWith('HSR1 ') || !keyMatches(line.slice(5))) {
      console.log('relay: tunnel authentication failed');
      socket.destroy();
      return;
    }
    offer(socket);
  };
  socket.on('data', onData);
  socket.on('close', () => clearTimeout(timer));
});

const apiServer = net.createServer((api) => {
  api.on('error', noop);
  let tunnel;
  while ((tunnel = idle.shift())) {
    if (!tunnel.destroyed) { pair(tunnel, api); return; }
  }
  api.pause();
  const w = { api, timer: setTimeout(() => {
    const i = waiting.indexOf(w);
    if (i !== -1) waiting.splice(i, 1);
    console.log('relay: no tunnel from the plugin; closed an API connection');
    api.destroy();
  }, WAIT_MS) };
  waiting.push(w);
  api.on('close', () => {
    clearTimeout(w.timer);
    const i = waiting.indexOf(w);
    if (i !== -1) waiting.splice(i, 1);
  });
});

const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', () => resolve(server.address().port)); });
const [apiPort, tunnelPort] = await Promise.all([listen(apiServer, API_PORT), listen(tunnelServer, TUNNEL_PORT)]);
console.log(JSON.stringify({ listening: true, apiPort, tunnelPort }));
