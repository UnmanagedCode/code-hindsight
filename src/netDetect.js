// Which host address to publish the Hindsight ports on when the user has not chosen one.
// Inside a container, only the default gateway reaches the Docker host's published ports;
// elsewhere loopback does.
import fs from 'node:fs';

/** The default route's gateway from /proc/net/route text, as dotted IPv4, or null. */
export function defaultGateway(procNetRoute) {
  for (const line of String(procNetRoute ?? '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000') continue;
    const hex = f[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex) || hex === '00000000') continue;
    // Little-endian: the last byte pair is the first octet.
    return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
  }
  return null;
}

/** The gateway when running in a container (and one is found), else 127.0.0.1. */
export function defaultBindAddress({ dockerenvExists, procNetRoute }) {
  if (dockerenvExists) {
    const gw = defaultGateway(procNetRoute);
    if (gw) return gw;
  }
  return '127.0.0.1';
}

/** `defaultBindAddress` over this machine's files. */
export function detectBindAddress() {
  let route = '';
  try { route = fs.readFileSync('/proc/net/route', 'utf8'); } catch { /* not Linux */ }
  return defaultBindAddress({ dockerenvExists: fs.existsSync('/.dockerenv'), procNetRoute: route });
}
