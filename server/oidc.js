// OpenID Connect sign-in (authorization code flow with PKCE).
//
// The in-flight login (state, nonce, PKCE verifier, where to return) lives in a short-lived signed
// cookie, so nothing is stored server-side and any node can run the flow. After the ID token is
// verified, the user gets the same signed session cookie as a password login, valid on every node.
//
// Settings come from the replicated cluster config (see settings.js). New settings can be tried
// before they are saved: a "test" sign-in uses a draft, and only an admin sign-in with the draft
// saves it, so a typo can't lock everyone out.
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';
import { sign, verify, parseCookies, setSession, isHttps } from './auth.js';
import * as audit from './audit.js';
import * as settings from './settings.js';
import * as cluster from './cluster.js';

const TX_COOKIE = 'sc_oidc';
const CALLBACK = '/auth/oidc/callback';
const rand = () => crypto.randomBytes(32).toString('base64url');
const s256 = v => crypto.createHash('sha256').update(v).digest('base64url');

const discoveries = new Map(); // issuer -> { meta, at, jwks }
export async function discovery(issuer) {
  const hit = discoveries.get(issuer);
  if (hit && Date.now() - hit.at < 3600e3) return hit;
  const url = `${issuer}/.well-known/openid-configuration`;
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } }); } catch (e) {
    throw new Error(`Could not reach ${url}: ${e.cause?.code || e.message}`);
  }
  if (!r.ok) throw new Error(`Could not load ${url} (HTTP ${r.status})`);
  const m = await r.json().catch(() => null);
  if (!m) throw new Error(`${url} did not return JSON`);
  if (String(m.issuer).replace(/\/+$/, '') !== issuer) throw new Error(`The issuer is set to ${issuer} but the provider says its issuer is ${m.issuer}`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!m[k]) throw new Error(`The provider's discovery document has no ${k}`);
  const d = { meta: m, at: Date.now(), jwks: createRemoteJWKSet(new URL(m.jwks_uri), { timeoutDuration: 8000 }) };
  discoveries.set(issuer, d);
  return d;
}

// Drafts being tested, on the node that started the test (the callback comes back to it).
const drafts = new Map();
export async function createDraft(value, baseV, user) {
  await discovery(value.issuer); // fail early if the provider can't be reached
  const id = crypto.randomUUID();
  drafts.set(id, { value, baseV, user, exp: Date.now() + 10 * 60e3 });
  for (const [k, d] of drafts) if (d.exp < Date.now()) drafts.delete(k);
  return id;
}

function origins() {
  return [config.nodeUrl, ...config.publicUrls].map(u => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean);
}
export function redirectUris() { return origins().map(o => o + CALLBACK); }
function redirectUri(req) {
  const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  return (origins().includes(origin) ? origin : new URL(config.nodeUrl).origin) + CALLBACK;
}
const safeReturn = p => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') ? p.slice(0, 500) : '/');
const txCookie = (req, value, maxAge) =>
  `${TX_COOKIE}=${value}; Path=/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
function fail(res, message) { res.redirect(303, `/#login-error=${encodeURIComponent(message.slice(0, 400))}`); }

export async function start(req, res) {
  const testId = typeof req.query.test === 'string' ? req.query.test : null;
  const draft = testId ? drafts.get(testId) : null;
  if (testId && (!draft || draft.exp < Date.now())) return fail(res, 'That test of the single sign-on settings expired. Start it again from Settings.');
  const o = draft ? draft.value : settings.oidc();
  if (!o) return fail(res, 'Single sign-on is turned off for this cluster.');
  let d;
  try { d = await discovery(o.issuer); } catch (e) { console.error('[oidc]', e.message); return fail(res, `Single sign-on is unavailable: ${e.message}`); }
  const state = rand(), nonce = rand(), verifier = rand();
  const redirect = redirectUri(req);
  const tx = sign({ typ: 'oidc', s: state, n: nonce, v: verifier, r: redirect, ret: safeReturn(req.query.return), t: testId, exp: Date.now() + 10 * 60e3 });
  res.append('Set-Cookie', txCookie(req, tx, 600));
  const u = new URL(d.meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('scope', o.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', s256(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  res.redirect(302, u.toString());
}

function claimAt(obj, path) { return path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), obj); }
function asList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean);
  return [];
}
function roleFor(o, claims) {
  const username = String(claimAt(claims, o.usernameClaim) || claims.email || claims.sub);
  const groups = asList(claimAt(claims, o.groupsClaim));
  const ids = [username, claims.sub, claims.email_verified === false ? null : claims.email].filter(Boolean).map(s => String(s).toLowerCase());
  const role = ['admin', 'operator', 'viewer'].find(r => o.roles[r].users.some(u => ids.includes(u)) || o.roles[r].groups.some(g => groups.includes(g)))
    || (o.defaultRole !== 'none' ? o.defaultRole : null);
  return { username, groups, role };
}

export async function callback(req, res) {
  const tx = verify(parseCookies(req.headers.cookie)[TX_COOKIE]);
  res.append('Set-Cookie', txCookie(req, '', 0));
  if (req.query.error) return fail(res, `The identity provider said: ${req.query.error_description || req.query.error}`);
  if (!tx || tx.typ !== 'oidc' || typeof req.query.state !== 'string' || req.query.state !== tx.s) {
    return fail(res, 'That sign-in attempt expired or was started in another browser. Try again.');
  }
  if (typeof req.query.code !== 'string') return fail(res, 'The identity provider did not return a code');
  const draft = tx.t ? drafts.get(tx.t) : null;
  if (tx.t && !draft) return fail(res, 'That test of the single sign-on settings expired. Start it again from Settings.');
  const o = draft ? draft.value : settings.oidc();
  if (!o) return fail(res, 'Single sign-on is turned off for this cluster.');

  try {
    const { meta: m, jwks } = await discovery(o.issuer);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: tx.r, code_verifier: tx.v });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (o.clientSecret) {
      const methods = m.token_endpoint_auth_methods_supported || ['client_secret_basic'];
      if (methods.includes('client_secret_basic')) {
        // Credentials go ONLY in the Authorization header. Some providers (PocketID) switch to
        // reading the form as the credential source the moment client_id appears in it, then
        // reject the call with "Client id or secret not provided" because the secret was in the
        // header. Sending client_id in both places is permitted by RFC 6749, but not portable.
        headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString('base64');
      } else {
        body.set('client_id', o.clientId);
        body.set('client_secret', o.clientSecret);
      }
    } else body.set('client_id', o.clientId);
    const tr = await fetch(m.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) return fail(res, `The identity provider refused the sign-in: ${tok.error_description || tok.error || `HTTP ${tr.status}`}`);
    const { payload } = await jwtVerify(tok.id_token, jwks, { issuer: m.issuer, audience: o.clientId, clockTolerance: 60 });
    if (payload.nonce !== tx.n) return fail(res, 'The sign-in response did not match this attempt. Try again.');

    let claims = { ...payload };
    if (m.userinfo_endpoint && tok.access_token) {
      try {
        const ur = await fetch(m.userinfo_endpoint, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (ur.ok) { const info = await ur.json(); if (info.sub === payload.sub) claims = { ...info, ...payload }; }
      } catch { /* the ID token is enough */ }
    }
    const { username, groups, role } = roleFor(o, claims);

    if (draft) {
      // A test only saves the settings if they make the person testing them an admin.
      if (role !== 'admin') {
        return fail(res, `The test sign-in worked, but with these settings ${username} would be ${role ? `${role}, not admin` : 'refused'} (groups: ${groups.join(', ') || 'none'}). Nothing was saved. Fix the role mapping and test again.`);
      }
      try {
        await cluster.writeGuarded('auth.oidc', draft.value, username, draft.baseV);
      } catch (e) {
        return fail(res, `The test sign-in worked, but the settings were not saved: ${e.message}. Reload Settings and try again.`);
      } finally { drafts.delete(tx.t); }
      audit.append({ who: username, msg: `Saved single sign-on settings (${draft.value.issuer}) after a successful test sign-in` });
    }
    if (!role) {
      audit.append({ who: username, msg: `Single sign-on refused for ${username}: no matching role` });
      const names = [...new Set(Object.values(o.roles).flatMap(r => r.groups))];
      return fail(res, `${username} signed in, but has no role in SelfCluster. ${names.length ? `Ask an admin to add you to ${names.join(', ')}.` : 'Ask an admin to add you to the allowed users.'}`);
    }
    setSession(req, res, username, { m: 'oidc', r: role, n: claims.name ? String(claims.name) : undefined, hours: settings.sessionHours() });
    audit.append({ who: username, msg: `Signed in with ${o.label} as ${role} from ${req.ip}` });
    res.redirect(303, draft ? '/#settings-saved' : tx.ret);
  } catch (e) {
    console.error('[oidc] callback:', e.code || '', e.message);
    fail(res, `Single sign-on failed: ${e.code === 'ERR_JWT_EXPIRED' ? 'the token expired (check the clocks on this node and the identity provider)' : e.message}`);
  }
}

export async function logoutUrl(req) {
  const o = settings.oidc();
  if (!o) return null;
  try {
    const { meta: m } = await discovery(o.issuer);
    if (!m.end_session_endpoint) return null;
    const u = new URL(m.end_session_endpoint);
    u.searchParams.set('client_id', o.clientId);
    u.searchParams.set('post_logout_redirect_uri', redirectUri(req).replace(CALLBACK, '/'));
    return u.toString();
  } catch { return null; }
}
