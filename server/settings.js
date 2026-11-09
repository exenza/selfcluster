// Sign-in settings shared by every node: the admin password (as a scrypt hash), single sign-on
// (OIDC) and the session length. They live in the replicated cluster config. .env values only seed
// a new cluster; after that the cluster's copy wins, and a node whose .env disagrees says so.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as cluster from './cluster.js';

// ---------- Passwords ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}
const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// ---------- OIDC ----------
const ROLE_NAMES = ['admin', 'operator', 'viewer'];
const list = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean);
export function normalizeOidc(input) {
  const roles = {};
  for (const r of ROLE_NAMES) {
    roles[r] = { groups: list(input?.roles?.[r]?.groups), users: list(input?.roles?.[r]?.users).map(u => u.toLowerCase()) };
  }
  const anyGroups = ROLE_NAMES.some(r => roles[r].groups.length);
  return {
    issuer: String(input?.issuer || '').trim().replace(/\/+$/, ''),
    clientId: String(input?.clientId || '').trim(),
    clientSecret: String(input?.clientSecret || ''),
    label: String(input?.label || '').trim() || 'single sign-on',
    scopes: String(input?.scopes || '').trim() || `openid profile email${anyGroups ? ' groups' : ''}`,
    usernameClaim: String(input?.usernameClaim || '').trim() || 'preferred_username',
    groupsClaim: String(input?.groupsClaim || '').trim() || 'groups',
    roles,
    defaultRole: ['none', ...ROLE_NAMES].includes(input?.defaultRole) ? input.defaultRole : 'none',
  };
}
export function validateOidc(o) {
  const bad = m => Object.assign(new Error(m), { status: 400 });
  if (!/^https?:\/\/[^/]/.test(o.issuer)) throw bad('Issuer must be a full URL, e.g. https://auth.example.com');
  if (!o.clientId) throw bad('Client ID is required');
  if (!ROLE_NAMES.some(r => o.roles[r].groups.length || o.roles[r].users.length) && o.defaultRole === 'none') {
    throw bad('Map at least one group or user to a role, or pick a default role, or nobody can sign in');
  }
}

// ---------- Effective settings ----------
export function admin() {
  const e = cluster.getEntry('auth.admin');
  if (e?.value?.hash) return { user: e.value.user || 'admin', hash: e.value.hash, source: 'cluster', v: e.v, by: e.by, ts: e.ts };
  if (config.adminPassword) return { user: config.adminUser, plain: config.adminPassword, source: 'env', v: e?.v || 0 };
  return null;
}
export function oidc() {
  const e = cluster.getEntry('auth.oidc');
  if (e) return e.value ? { ...normalizeOidc(e.value), source: 'cluster', v: e.v, by: e.by, ts: e.ts } : null; // null = turned off
  return config.oidc ? { ...normalizeOidc(config.oidc), source: 'env', v: 0 } : null;
}
export function oidcVersion() { return cluster.getEntry('auth.oidc')?.v || 0; }
export function sessionHours() {
  const h = cluster.getEntry('auth.session')?.value?.hours;
  return Number(h) > 0 ? Number(h) : config.sessionHours;
}
export const passwordLogin = () => !!admin() && (!oidc() || config.breakGlass);
export const configured = () => !!admin() || !!oidc();

export function checkPassword(user, pw) {
  const a = admin();
  if (!passwordLogin() || !a) return false;
  const userOk = safeEqual(String(user), a.user);
  const pwOk = a.hash ? verifyPassword(pw, a.hash) : safeEqual(pw, a.plain);
  return userOk && pwOk;
}

// ---------- Seeding and drift ----------
const by = () => `${config.nodeId} (.env)`;
export function seedFromEnv() {
  let seeded = false;
  if (!cluster.hasEntry('auth.admin') && config.adminPassword) {
    cluster.setEntry('auth.admin', { user: config.adminUser, hash: hashPassword(config.adminPassword) }, by());
    seeded = true;
  }
  if (!cluster.hasEntry('auth.oidc') && config.oidc) {
    cluster.setEntry('auth.oidc', normalizeOidc(config.oidc), by());
    seeded = true;
  }
  if (!cluster.hasEntry('auth.session') && process.env.SESSION_HOURS) {
    cluster.setEntry('auth.session', { hours: config.sessionHours }, by());
    seeded = true;
  }
  return seeded;
}

// Which .env settings on this node differ from what the cluster uses.
let pwCheck = { key: null, same: true };
export function envDrift() {
  const out = [];
  const a = cluster.getEntry('auth.admin');
  if (a?.value?.hash && config.adminPassword) {
    const key = a.value.hash;
    if (pwCheck.key !== key) pwCheck = { key, same: verifyPassword(config.adminPassword, a.value.hash) };
    if (!pwCheck.same) out.push('ADMIN_PASSWORD');
    if (process.env.ADMIN_USER && process.env.ADMIN_USER !== a.value.user) out.push('ADMIN_USER');
  }
  const o = cluster.getEntry('auth.oidc');
  if (o && config.oidc) {
    if (!o.value) out.push('OIDC_* (single sign-on is turned off for the cluster)');
    else {
      const env = normalizeOidc(config.oidc), cl = normalizeOidc(o.value);
      const names = { issuer: 'OIDC_ISSUER', clientId: 'OIDC_CLIENT_ID', clientSecret: 'OIDC_CLIENT_SECRET', label: 'OIDC_LABEL', scopes: 'OIDC_SCOPES', usernameClaim: 'OIDC_USERNAME_CLAIM', groupsClaim: 'OIDC_GROUPS_CLAIM', roles: 'OIDC_*_GROUPS / OIDC_*_USERS', defaultRole: 'OIDC_DEFAULT_ROLE' };
      for (const [k, n] of Object.entries(names)) if (JSON.stringify(env[k]) !== JSON.stringify(cl[k])) out.push(n);
    }
  }
  const s = cluster.getEntry('auth.session');
  if (s && process.env.SESSION_HOURS && Number(process.env.SESSION_HOURS) !== Number(s.value?.hours)) out.push('SESSION_HOURS');
  return out;
}

// What the settings page may show: never the password hash or the client secret.
export function publicView() {
  const a = admin(), o = oidc();
  const ae = cluster.getEntry('auth.admin'), oe = cluster.getEntry('auth.oidc'), se = cluster.getEntry('auth.session');
  return {
    admin: { user: a?.user || 'admin', set: !!a, v: ae?.v || 0, by: ae?.by || null, ts: ae?.ts || null, source: a?.source || null },
    oidc: {
      enabled: !!o, v: oe?.v || 0, by: oe?.by || null, ts: oe?.ts || null, source: o?.source || (oe ? 'cluster' : null),
      ...(o ? { ...o, clientSecret: undefined, clientSecretSet: !!o.clientSecret } : {}),
    },
    session: { hours: sessionHours(), v: se?.v || 0, by: se?.by || null, ts: se?.ts || null },
    breakGlassHere: config.breakGlass,
  };
}
