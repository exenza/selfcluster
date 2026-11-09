// Sessions, login, node-to-node handoff and peer request signing.
// Everything is derived from CLUSTER_SECRET, so a session issued by one node is valid on all of them.
import crypto from 'node:crypto';
import { config } from './config.js';

const sessionKey = crypto.createHash('sha256').update('selfcluster-session\0' + config.secret).digest();
const peerKey = crypto.createHash('sha256').update('selfcluster-peer\0' + config.secret).digest();
const COOKIE = 'sc_session';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${p}.${hmac(sessionKey, p)}`;
}
export function verify(token) {
  if (typeof token !== 'string') return null;
  const [p, s] = token.split('.');
  if (!p || !s || !safeEqual(s, hmac(sessionKey, p))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.exp && o.exp < Date.now() ? null : o;
  } catch { return null; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Session payload: u = user name, m = 'password' | 'oidc', n = display name, r = role.
export function sessionInfo(req) {
  const o = verify(parseCookies(req.headers.cookie)[COOKIE]);
  return o && o.typ === 'session' ? o : null;
}
export function sessionUser(req) { return sessionInfo(req)?.u || null; }
export function isHttps(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
export function setSession(req, res, user, extra = {}) {
  // Break-glass sessions stay short wherever they are issued, including handoffs to other nodes.
  const hours = extra.m === 'break-glass' ? 1 : (extra.hours || config.sessionHours);
  const maxAge = Math.round(hours * 3600);
  const token = sign({ typ: 'session', u: user, m: extra.m || 'password', r: extra.r || 'admin', ...(extra.n ? { n: extra.n } : {}), exp: Date.now() + maxAge * 1000 });
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`);
}
export function clearSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const attempts = new Map();
export function loginBlocked(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 5 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}
export function loginFailed(ip) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); }

// One-time, 30-second token used when the UI switches to another node (a different origin).
const usedHandoffs = new Map();
export function makeHandoff(session, toNode) {
  return sign({ typ: 'handoff', u: session.u, m: session.m, n: session.n, r: session.r || 'admin', aud: toNode, exp: Date.now() + 30e3, j: crypto.randomUUID() });
}
export function redeemHandoff(token) {
  const o = verify(token);
  if (!o || o.typ !== 'handoff' || o.aud !== config.nodeId || usedHandoffs.has(o.j)) return null;
  usedHandoffs.set(o.j, o.exp);
  for (const [j, exp] of usedHandoffs) if (exp < Date.now()) usedHandoffs.delete(j);
  return { u: o.u, m: o.m, n: o.n, r: o.r || 'admin' };
}

// Peer requests are signed over node id, timestamp, method and path.
export function peerHeaders(method, path) {
  const ts = String(Date.now());
  return {
    'x-sc-node': config.nodeId,
    'x-sc-ts': ts,
    'x-sc-sig': hmac(peerKey, `${config.nodeId}\n${ts}\n${method.toUpperCase()}\n${path}`),
  };
}
export function verifyPeer(req) {
  const node = req.headers['x-sc-node'], ts = req.headers['x-sc-ts'], sig = req.headers['x-sc-sig'];
  if (!node || !ts || !sig) return null;
  if (Math.abs(Date.now() - Number(ts)) > 60e3) return null;
  const path = req.originalUrl || req.url;
  return safeEqual(sig, hmac(peerKey, `${node}\n${ts}\n${req.method.toUpperCase()}\n${path}`)) ? String(node) : null;
}
