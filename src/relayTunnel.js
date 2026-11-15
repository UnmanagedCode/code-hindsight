// The plugin's side of the relay tunnel: keeps a few authenticated idle connections open to
// the relay's published port. When the relay sends the go byte (0x01) the connection carries
// one API client's request, so it is handed to `onSocket` and a replacement is opened.
// Wire protocol: send `HSR1 <key>\n`; the relay later writes the go byte 0x01. Once the socket is
// handed over, the plugin answers with one ack byte; only then does the relay send the client's bytes.
import net from 'node:net';

const CONNECT_TIMEOUT_MS = 5_000;
const KEEPALIVE_MS = 15_000;
const GO = 0x01;
const ACK = Buffer.from([0x01]);

/**
 * @param {object} o
 * @param {string} o.key the relay key
 * @param {(socket: import('node:net').Socket) => void} o.onSocket takes over a paired connection
 * @param {number} [o.idleTarget] idle connections kept open
 * @param {number} [o.retryMs] first reconnect delay (doubles per consecutive failure)
 * @param {number} [o.maxRetryMs]
 * @param {(msg: string) => void} [o.log]
 */
export function createRelayTunnel({ key, onSocket, idleTarget = 4, retryMs = 1_000, maxRetryMs = 30_000, log = () => {} }) {
  let target = null;
  let epoch = 0;
  const idle = new Set();
  let connecting = 0;
  let failures = 0;
  let error = null;
  let timer = null;

  function fail(detail) {
    failures++;
    error = detail;
    if (timer) return;
    const wait = Math.min(retryMs * 2 ** (failures - 1), maxRetryMs);
    const mine = epoch;
    timer = setTimeout(() => { timer = null; if (mine === epoch) fill(); }, wait);
    timer.unref?.();
  }

  function open() {
    const mine = epoch;
    const { host, port } = target;
    connecting++;
    const socket = net.connect({ host, port });
    let connectedAt = 0;
    let handedOff = false;
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error('connect timed out')));
    socket.on('error', (e) => { if (mine === epoch && !connectedAt) fail(e.code ?? e.message); });
    socket.on('connect', () => {
      if (mine === epoch) connecting--;
      connectedAt = Date.now();
      if (mine !== epoch) { socket.destroy(); return; }
      socket.setTimeout(0);
      socket.setKeepAlive(true, KEEPALIVE_MS);
      socket.write(`HSR1 ${key}\n`);
      idle.add(socket);
      error = null;
    });
    socket.once('data', function onFirst(chunk) {
      if (chunk.length !== 1 || chunk[0] !== GO) { socket.destroy(); return; }
      handedOff = true;
      idle.delete(socket);
      failures = 0;
      onSocket(socket);
      socket.write(ACK);
      if (mine === epoch) fill();
    });
    socket.on('close', () => {
      if (!connectedAt && mine === epoch) connecting--; // never connected: the error handler recorded why
      idle.delete(socket);
      if (mine !== epoch || handedOff) return;
      if (connectedAt) {
        // An idle socket the relay closed (restart, or it refused the key).
        if (Date.now() - connectedAt > maxRetryMs) failures = 0;
        fail('the relay closed the tunnel');
      }
    });
  }

  function fill() {
    if (!target || timer) return;
    for (let n = idle.size + connecting; n < idleTarget; n++) open();
  }

  function stop() {
    epoch++;
    target = null;
    if (timer) { clearTimeout(timer); timer = null; }
    for (const s of idle) s.destroy();
    idle.clear();
    connecting = 0;
    failures = 0;
    error = null;
  }

  return {
    /** Connect to the relay; a running tunnel to the same address is kept. */
    start({ host, port }) {
      if (target && target.host === host && target.port === port) return;
      stop();
      target = { host, port };
      log(`relay tunnel: dialling ${host}:${port}`);
      fill();
    },
    stop,
    status() {
      const state = !target ? 'stopped' : idle.size > 0 ? 'connected' : 'connecting';
      return { state, idle: idle.size, error: state === 'connected' ? null : error, address: target ? `${target.host}:${target.port}` : null };
    },
  };
}
