// Server-side sign-in to the Hindsight control plane. The backend holds the CP session
// token and adds it to proxied requests, so the browser never sees the access key or the
// CP's `Path=/` cookie.
import http from 'node:http';
import { AppError } from './errors.js';
import { BASE_PATH, CP_COOKIE } from './pins.js';

/** Upstream sessions last 24 h; renew well before. */
const RENEW_AFTER_MS = 20 * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 15_000;

/** The value of `name` in a list of Set-Cookie header lines, or null. */
export function cookieValue(setCookies, name) {
  for (const line of setCookies ?? []) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(line);
    if (m && m[1] === name) return m[2];
  }
  return null;
}

/**
 * @param {object} o
 * @param {() => ({host: string, port: number} | null)} o.target where the CP listens
 * @param {() => string} o.accessKey the CP's HINDSIGHT_CP_ACCESS_KEY
 * @param {() => number} [o.now]
 */
export function createCpSession({ target, accessKey, now = Date.now }) {
  let token = null;
  let issuedAt = 0;
  let inflight = null;

  function login() {
    const t = target();
    if (!t) return Promise.reject(new AppError('NOT_READY'));
    const body = JSON.stringify({ key: accessKey() });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: t.host, port: t.port, method: 'POST', path: `${BASE_PATH}/api/auth/login`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: LOGIN_TIMEOUT_MS,
      }, (res) => {
        res.resume();
        res.on('end', () => {
          const value = res.statusCode === 200 ? cookieValue(res.headers['set-cookie'], CP_COOKIE) : null;
          if (!value) return reject(new AppError('CP_LOGIN_FAILED', { detail: `HTTP ${res.statusCode}` }));
          token = value;
          issuedAt = now();
          resolve(value);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new AppError('CP_LOGIN_FAILED', { detail: e.message })));
      req.end(body);
    });
  }

  return {
    /** A valid session token, signing in when there is none or it is old. Single-flight. */
    async token() {
      if (token && now() - issuedAt < RENEW_AFTER_MS) return token;
      return this.relogin();
    },
    /** Sign in again now (after the CP rejected the token). */
    relogin() {
      if (!inflight) inflight = login().finally(() => { inflight = null; });
      return inflight;
    },
    /** Drop the token (the CP was recreated with a new key, or stopped). */
    clear() {
      token = null;
      issuedAt = 0;
    },
  };
}
