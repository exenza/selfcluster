import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const auth = await import('./auth.js');
const audit = await import('./audit.js');
const dockerApi = await import('./docker.js');
const stacks = await import('./stacks.js');
const cluster = await import('./cluster.js');
const roles = await import('./roles.js');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '4mb' }));

const H = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const who = req => ({ user: req.user, via: req.via });
const ID_RE = /^[a-f0-9]{12,64}$/;

// ---------- Static UI ----------
app.get('/healthz', (req, res) => res.json({ ok: true, node: config.nodeId }));
app.use('/vendor/xterm', express.static(path.join(root, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(root, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(root, 'public'), { index: 'index.html', maxAge: 0 }));

// ---------- Sign-in ----------
const settings = await import('./settings.js');
const oidc = await import('./oidc.js');
app.get('/api/auth-config', (req, res) => {
  const o = settings.oidc();
  res.json({
    node: config.nodeId,
    configured: settings.configured(),
    password: settings.passwordLogin(),
    breakGlass: !!o && settings.passwordLogin(),
    oidc: o ? { label: o.label } : null,
  });
});
app.get('/auth/oidc/login', H(oidc.start));
app.get('/auth/oidc/callback', H(oidc.callback));
app.post('/api/login', (req, res) => {
  const o = settings.oidc();
  if (!settings.passwordLogin()) {
    return res.status(403).json({ error: o
      ? `Password sign-in is off because ${o.label} is set up. To use it in an emergency, set BREAK_GLASS=true in this node's .env and restart SelfCluster.`
      : 'This node has no sign-in settings yet. Add it to the cluster from another node, or set ADMIN_PASSWORD in its .env.' });
  }
  const ip = req.ip;
  if (auth.loginBlocked(ip)) return res.status(429).json({ error: 'Too many failed attempts. Wait 5 minutes and try again.' });
  const { user = '', password = '' } = req.body || {};
  if (!settings.checkPassword(String(user), String(password))) {
    auth.loginFailed(ip);
    return res.status(401).json({ error: 'Wrong user name or password' });
  }
  // With single sign-on on, the password is break-glass only: sessions are short (1 hour).
  const breakGlass = !!o;
  auth.setSession(req, res, String(user), { m: breakGlass ? 'break-glass' : 'password', hours: settings.sessionHours() });
  audit.append({ who: String(user), msg: `Signed in with the ${breakGlass ? 'break-glass ' : ''}admin password from ${ip}` });
  res.json({ ok: true });
});
app.post('/api/logout', H(async (req, res) => {
  const s = auth.sessionInfo(req);
  auth.clearSession(res);
  // Signing out of SelfCluster also ends the identity provider session when it supports that.
  res.json({ ok: true, redirect: s?.m === 'oidc' ? await oidc.logoutUrl(req) : null });
}));
app.post('/api/handoff/redeem', (req, res) => {
  const s = auth.redeemHandoff(req.body?.token);
  if (!s) return res.status(401).json({ error: 'The link to this node expired. Sign in again.' });
  auth.setSession(req, res, s.u, { m: s.m, n: s.n, r: s.r, hours: settings.sessionHours() });
  res.json({ ok: true });
});

// Every /api and /peer route needs either a signed-in user or a signed request from a peer.
app.use(['/api', '/peer'], (req, res, next) => {
  const peerId = auth.verifyPeer(req);
  if (peerId) {
    req.peer = peerId;
    req.user = String(req.headers['x-sc-user'] || `node:${peerId}`);
    req.via = String(req.headers['x-sc-via'] || peerId);
    // A relayed request carries the user's role; without one a peer gets the least privilege.
    const r = String(req.headers['x-sc-role'] || '');
    req.role = roles.isRole(r) ? r : 'viewer';
    return next();
  }
  const session = auth.sessionInfo(req);
  if (!session) return res.status(401).json({ error: 'Sign in required' });
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'selfcluster') return res.status(403).json({ error: 'Missing request header' });
  req.session = session;
  req.user = session.u;
  req.role = roles.isRole(session.r) ? session.r : 'admin'; // sessions from before roles existed were all admin
  req.via = config.nodeId;
  next();
});
app.use('/api', (req, res, next) => {
  const need = roles.requiredRole(req.method, req.originalUrl.split('?')[0]);
  if (roles.atLeast(req.role, need)) return next();
  res.status(403).json({ error: roles.denied(req.role, need), role: req.role, needs: need });
});
const userHeaders = req => ({ 'x-sc-user': req.user, 'x-sc-via': req.via, 'x-sc-role': req.role, 'x-sc-hop': '1' });
app.use('/peer', (req, res, next) => (req.peer ? next() : res.status(403).json({ error: 'Only other SelfCluster nodes can call this' })));

// ---------- Local state ----------
let invCache = null, invAt = 0;
async function inventory() {
  if (invCache && Date.now() - invAt < 1500) return invCache;
  const ctrs = await dockerApi.listContainers();
  const list = await stacks.listStacks(ctrs);
  const byName = new Map(list.map(s => [s.name, { ...s, containers: [] }]));
  const standalone = [];
  for (const c of ctrs) {
    if (!c.project) { standalone.push(c); continue; }
    // Project names compose accepts but SelfCluster can't address (rare) are shown without files.
    if (!byName.has(c.project)) byName.set(c.project, { name: c.project, dir: c.workdir, filesMissing: true, unmanaged: true, containers: [] });
    byName.get(c.project).containers.push(c);
  }
  const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of all) {
    s.containers.sort((a, b) => a.name.localeCompare(b.name));
    s.self = s.containers.some(c => c.self);
  }
  invCache = { node: config.nodeId, at: Date.now(), stacks: all, standalone: standalone.sort((a, b) => a.name.localeCompare(b.name)) };
  invAt = Date.now();
  return invCache;
}

async function hostStats() {
  const e = await dockerApi.engineInfo().catch(() => null);
  let disk = null;
  try { const s = await fsp.statfs(stacks.hp(config.stacksDir)); disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize }; } catch { /* missing dir */ }
  return {
    cpus: e?.cpus || os.cpus().length, load: os.loadavg()[0],
    memTotal: e?.memTotal || os.totalmem(), memUsed: os.totalmem() - os.freemem(),
    disk, engine: e?.engine || null, os: e?.os || null, hostname: e?.hostname || os.hostname(),
  };
}
function counts(inv) {
  const all = [...inv.stacks.flatMap(s => s.containers), ...inv.standalone];
  return { running: all.filter(c => c.state === 'running').length, total: all.length };
}

async function selfState() {
  const inv = await inventory().catch(() => ({ stacks: [], standalone: [] }));
  return {
    id: config.nodeId, url: config.nodeUrl, agent: config.version, ver: cluster.version(), digest: cluster.digest(), breakGlass: !!settings.oidc() && config.breakGlass, envDrift: settings.envDrift(),
    entries: cluster.allEntries(), host: await hostStats(), containers: counts(inv), audit: audit.recent(30), auditCount: audit.count(), time: Date.now(),
  };
}

app.get('/peer/state', H(async (req, res) => res.json(await selfState())));
app.post('/peer/merge', (req, res) => { cluster.merge(req.body?.entries); res.json({ ok: true }); });
// Conditional writes: another node asks us to confirm we're still at its base version and to hold
// the key for a few seconds, then commits (merge + release) or releases.
app.post('/peer/prepare', (req, res) => {
  const { key, baseId, token } = req.body || {};
  if (typeof key !== 'string' || typeof token !== 'string') return res.status(400).json({ error: 'bad request' });
  const r = cluster.reserve(key, baseId ?? null, token);
  res.status(r.ok ? 200 : 409).json(r);
});
app.post('/peer/commit', (req, res) => {
  cluster.merge(req.body?.entries);
  cluster.release(String(req.body?.key || ''), String(req.body?.token || ''));
  res.json({ ok: true });
});
app.post('/peer/release', (req, res) => { cluster.release(String(req.body?.key || ''), String(req.body?.token || '')); res.json({ ok: true }); });
app.get('/peer/snapshot', H(async (req, res) => {
  const inv = await inventory();
  const files = {};
  for (const s of inv.stacks.filter(x => !x.filesMissing)) {
    try { files[s.name] = await stacks.readFiles(s.name); } catch { /* skip unreadable */ }
  }
  res.json({ at: Date.now(), node: config.nodeId, url: config.nodeUrl, agent: config.version, host: await hostStats(), inventory: inv, files });
}));

// ---------- Cluster-wide API ----------
app.get('/api/me', (req, res) => res.json({
  user: req.user, name: req.session?.n || null, method: req.session?.m || 'password', role: req.role,
  node: config.nodeId, url: config.nodeUrl, version: config.version, stacksDir: config.stacksDir,
}));

app.get('/api/cluster', H(async (req, res) => {
  const self = await selfState();
  const nodes = cluster.nodeList().map(n => n.self
    ? { id: n.id, url: n.url, self: true, online: true, lastSeen: Date.now(), latency: 0, agent: self.agent, breakGlass: self.breakGlass, envDrift: self.envDrift, digest: self.digest, ver: self.ver, host: self.host, containers: self.containers }
    : { id: n.id, url: n.url, self: false, online: n.online, lastSeen: n.lastSeen || 0, latency: n.latency ?? null, agent: n.agent || null, breakGlass: !!n.breakGlass, envDrift: n.envDrift || [], digest: n.digest || null, ver: n.ver ?? null, host: n.host || null, containers: n.containers || null, error: n.error || null, neverSeen: !!n.neverSeen });
  const seen = new Set();
  const merged = [self.audit, ...cluster.nodeList().filter(n => !n.self).map(n => n.audit || [])].flat()
    .filter(a => a && !seen.has(a.id) && seen.add(a.id)).sort((a, b) => b.t - a.t).slice(0, 60);
  const shared = cluster.getEntry('sharedEnv');
  res.json({
    self: config.nodeId, vip: config.vip, ver: self.ver, digest: self.digest, nodes,
    entries: Object.entries(cluster.allEntries()).map(([key, e]) => ({ key, v: e.v, ts: e.ts, by: e.by, deleted: !!e.deleted })),
    sharedEnv: { value: roles.atLeast(req.role, 'admin') ? (shared?.value ?? '') : roles.maskEnv(shared?.value ?? ''), v: shared?.v || 0, by: shared?.by || null, ts: shared?.ts || null },
    audit: merged, auditCount: self.auditCount,
  });
}));

app.get('/api/overview', H(async (req, res) => {
  const out = await Promise.all(cluster.nodeList().map(async n => {
    if (n.self) return { ...(await inventory()), node: n.id, online: true };
    if (n.online) {
      try {
        const r = await cluster.signedFetch(n.url, `/api/n/${encodeURIComponent(n.id)}/inventory`, { headers: userHeaders(req), timeout: 4000 });
        if (r.ok) return { ...(await r.json()), node: n.id, online: true };
      } catch { /* fall back to cache */ }
    }
    const c = await cluster.cached(n.id);
    return { node: n.id, online: false, cachedAt: c?.at || null, lastSeen: n.lastSeen || 0, stacks: c?.inventory?.stacks || [], standalone: c?.inventory?.standalone || [] };
  }));
  res.json(out);
}));

app.post('/api/handoff', (req, res) => {
  const to = String(req.body?.to || '');
  const p = cluster.peer(to);
  if (!p || !p.online) return res.status(404).json({ error: `${to} is not reachable right now` });
  res.json({ url: `${p.url}/#handoff=${auth.makeHandoff({ ...(req.session || { u: req.user, m: 'password' }), r: req.role }, to)}` });
});

function sendConflict(res, e, view) {
  return res.status(409).json({ error: e.message, busy: !!e.busy, current: e.current ? view(e.current) : null });
}
app.put('/api/cluster/shared-env', H(async (req, res) => {
  const { content, v } = req.body || {};
  if (typeof content !== 'string' || content.length > 200_000) return res.status(400).json({ error: 'shared.env content is missing or too large' });
  let e;
  try { e = await cluster.writeGuarded('sharedEnv', content, req.user, v); } catch (err) {
    if (err.status === 409) return sendConflict(res, err, c => ({ value: c.value ?? '', v: c.v, by: c.by, ts: c.ts }));
    throw err;
  }
  audit.append({ who: req.user, via: req.via, msg: `Saved shared.env (v${e.v})` });
  res.json({ value: e.value, v: e.v, by: e.by, ts: e.ts });
}));

// ---------- Sign-in settings (admin only, see roles.js) ----------
function settingsView() {
  return {
    ...settings.publicView(),
    redirectUris: cluster.nodeList().map(n => `${n.url}/auth/oidc/callback`),
    publicRedirectUris: oidc.redirectUris(),
    collisions: cluster.collisions().map(c => ({ id: c.id, key: c.key, loserBy: c.loser?.by, loserNode: c.loser?.node || null, loserTs: c.loser?.ts, winnerBy: c.winnerBy, winnerNode: c.winnerNode, winnerTs: c.winnerTs })),
  };
}
const settingsConflict = (res, e) => res.status(409).json({ error: e.message, busy: !!e.busy, settings: settingsView() });
app.get('/api/settings', (req, res) => res.json(settingsView()));
app.put('/api/settings/admin', H(async (req, res) => {
  const { user, password, v } = req.body || {};
  const name = String(user || '').trim();
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(name)) return res.status(400).json({ error: 'User name: letters, digits, ".", "_", "-" or "@"' });
  if (typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters' });
  try { await cluster.writeGuarded('auth.admin', { user: name, hash: settings.hashPassword(password) }, req.user, v); }
  catch (e) { if (e.status === 409) return settingsConflict(res, e); throw e; }
  audit.append({ who: req.user, via: req.via, msg: 'Changed the admin password for the cluster' });
  res.json(settingsView());
}));
app.put('/api/settings/session', H(async (req, res) => {
  const hours = Number(req.body?.hours);
  if (!(hours >= 1 && hours <= 24 * 90)) return res.status(400).json({ error: 'Session length must be between 1 hour and 90 days' });
  try { await cluster.writeGuarded('auth.session', { hours }, req.user, req.body?.v); }
  catch (e) { if (e.status === 409) return settingsConflict(res, e); throw e; }
  audit.append({ who: req.user, via: req.via, msg: `Set the session length to ${hours} hours` });
  res.json(settingsView());
}));
// New OIDC settings are never saved directly: this returns a URL that runs a test sign-in with
// them, and only a successful admin sign-in saves them (see oidc.js).
app.post('/api/settings/oidc/test', H(async (req, res) => {
  const cur = settings.oidc();
  const draft = settings.normalizeOidc({ ...req.body?.oidc, clientSecret: req.body?.oidc?.clientSecret || cur?.clientSecret || '' });
  settings.validateOidc(draft);
  if (settings.oidcVersion() !== Number(req.body?.v || 0)) return settingsConflict(res, Object.assign(new Error('The single sign-on settings were changed by someone else after you opened them'), {}));
  let id;
  try { id = await oidc.createDraft(draft, settings.oidcVersion(), req.user); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json({ url: `/auth/oidc/login?test=${encodeURIComponent(id)}` });
}));
app.post('/api/settings/oidc/disable', H(async (req, res) => {
  if (!settings.admin()) return res.status(400).json({ error: 'Set an admin password first, or nobody could sign in after single sign-on is turned off' });
  try { await cluster.writeGuarded('auth.oidc', null, req.user, req.body?.v); }
  catch (e) { if (e.status === 409) return settingsConflict(res, e); throw e; }
  audit.append({ who: req.user, via: req.via, msg: 'Turned off single sign-on for the cluster' });
  res.json(settingsView());
}));
app.post('/api/settings/collisions/:id/:act(keep|restore)', H(async (req, res) => {
  const c = cluster.collisions().find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'That collision was already resolved' });
  if (req.params.act === 'restore') {
    const loser = cluster.openLoser(c);
    if (!loser) return res.status(400).json({ error: 'The other version can no longer be read' });
    try { await cluster.writeGuarded(c.key, loser.value, req.user, cluster.getEntry(c.key)?.v || 0); }
    catch (e) { if (e.status === 409) return settingsConflict(res, e); throw e; }
  }
  cluster.setEntry(c.id, null, req.user, true);
  cluster.pushNow();
  audit.append({ who: req.user, via: req.via, msg: `${req.params.act === 'restore' ? 'Restored' : 'Kept'} ${req.params.act === 'restore' ? `${c.loser?.by}'s` : 'the current'} version of ${c.key} after a collision` });
  res.json(settingsView());
}));

app.post('/api/cluster/nodes', H(async (req, res) => {
  const n = await cluster.addNode(req.body?.url, req.user);
  audit.append({ who: req.user, via: req.via, msg: `Added ${n.id} (${n.url}) to the cluster` });
  res.json(n);
}));
app.post('/api/cluster/forget', H(async (req, res) => {
  const id = String(req.body?.id || '');
  await cluster.forget(id, req.user);
  audit.append({ who: req.user, via: req.via, msg: `Removed ${id} from the cluster` });
  res.json({ ok: true });
}));

// ---------- Node-scoped API: handled here, or relayed to the node that owns it ----------
const LONG = /\/(up|down|pull)$|\/stacks$/;
async function relayHttp(req, res, p) {
  const pathname = req.originalUrl;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  try {
    const r = await cluster.signedFetch(p.url, pathname, {
      method: req.method,
      headers: userHeaders(req),
      body: hasBody ? (req.body || {}) : undefined,
      timeout: LONG.test(req.path) ? 20 * 60e3 : 15000,
    });
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: `Could not reach ${p.id}: ${e.cause?.code || e.message}` });
  }
}

app.use('/api/n/:node', H(async (req, res, next) => {
  const id = req.params.node;
  if (id === config.nodeId) return next();
  if (req.peer && req.headers['x-sc-hop']) return res.status(508).json({ error: `Request for ${id} reached ${config.nodeId}; nodes disagree about who is who` });
  const p = cluster.peer(id);
  if (!p) return res.status(404).json({ error: `Unknown node ${id}` });
  if (p.online) return relayHttp(req, res, p);
  if (req.method === 'GET') {
    const snap = await cluster.cached(id);
    if (snap && req.path === '/inventory') return res.json({ ...snap.inventory, cachedAt: snap.at });
    const m = req.path.match(/^\/stacks\/([^/]+)\/files$/);
    if (snap && m && snap.files?.[m[1]]) {
      const f = roles.atLeast(req.role, 'admin') ? snap.files[m[1]] : roles.maskFiles(snap.files[m[1]]);
      return res.json({ ...f, readOnly: true, cachedAt: snap.at });
    }
  }
  res.status(503).json({ error: `${id} is unreachable`, offline: true });
}));

const node = express.Router();
app.use('/api/n/:node', node);

node.get('/inventory', H(async (req, res) => res.json(await inventory())));
node.get('/stacks/:stack/files', H(async (req, res) => {
  const f = await stacks.readFiles(req.params.stack);
  res.json(roles.atLeast(req.role, 'admin') ? f : roles.maskFiles(f));
}));
node.put('/stacks/:stack/files/:file', H(async (req, res) => {
  const { content, etag } = req.body || {};
  const r = await stacks.writeFile(req.params.stack, req.params.file, content, etag || null, who(req));
  audit.append({ ...who(req), msg: `Saved ${config.nodeId}:${r.path}` });
  res.json(r);
}));
node.post('/stacks/:stack/validate', H(async (req, res) => {
  await stacks.composeValidate(req.params.stack, String(req.body?.content ?? ''));
  res.json({ ok: true });
}));
node.post('/stacks/:stack/:op(up|down|pull)', H(async (req, res) => {
  invCache = null;
  const s = (await inventory()).stacks.find(x => x.name === req.params.stack);
  if (s?.self && req.params.op !== 'pull') {
    return res.status(409).json({ error: `${s.name} is SelfCluster's own stack: running compose ${req.params.op} from inside it would stop SelfCluster halfway. Run docker compose up -d for it on the host instead.` });
  }
  const out = await stacks.compose(req.params.stack, req.params.op);
  invCache = null;
  audit.append({ ...who(req), msg: `docker compose ${req.params.op} ${config.nodeId} / ${req.params.stack}` });
  res.json({ ok: true, output: out });
}));
node.post('/stacks/:stack/forget', H(async (req, res) => {
  invCache = null;
  const s = (await inventory()).stacks.find(x => x.name === req.params.stack);
  if (s?.containers.length) return res.status(409).json({ error: `${s.name} still has containers. Run Down first, then forget it.` });
  stacks.forgetStack(req.params.stack);
  invCache = null;
  audit.append({ ...who(req), msg: `Forgot stack ${config.nodeId} / ${req.params.stack} (files were not touched)` });
  res.json({ ok: true });
}));
node.post('/stacks', H(async (req, res) => {
  const { name, files, up } = req.body || {};
  const r = await stacks.createStack(String(name || ''), files, who(req));
  audit.append({ ...who(req), msg: `Created stack ${config.nodeId} / ${name}` });
  let output = '';
  if (up) {
    output = await stacks.compose(name, 'up');
    audit.append({ ...who(req), msg: `docker compose up ${config.nodeId} / ${name}` });
  }
  invCache = null;
  res.json({ ...r, output });
}));

function checkId(req) {
  if (!ID_RE.test(req.params.id)) throw Object.assign(new Error('Invalid container id'), { status: 400 });
}
node.get('/containers/:id/readback', H(async (req, res) => { checkId(req); res.json({ content: await dockerApi.readback(req.params.id) }); }));
node.get('/containers/:id/stats', H(async (req, res) => { checkId(req); res.json(await dockerApi.containerStats(req.params.id)); }));
node.post('/containers/:id/:act(start|stop|restart|pull|remove)', H(async (req, res) => {
  checkId(req);
  const c = await dockerApi.findContainer(req.params.id);
  if (!c) return res.status(404).json({ error: 'That container no longer exists' });
  if (c.self && ['stop', 'remove'].includes(req.params.act)) return res.status(400).json({ error: 'SelfCluster cannot stop or remove its own container. Use docker compose on the host.' });
  await dockerApi.containerAction(c.id, req.params.act);
  invCache = null;
  audit.append({ ...who(req), msg: `${req.params.act} ${config.nodeId} / ${c.project || 'standalone'} / ${c.name}` });
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.output) console.error('[api]', req.method, req.originalUrl, err.message);
  const message = err.json?.message || err.reason || err.message || 'Something went wrong';
  res.status(status >= 100 && status < 600 ? status : 500).json({ error: message, ...(err.current !== undefined ? { current: err.current } : {}), ...(err.output ? { output: err.output } : {}) });
});

// ---------- WebSockets: logs and terminal ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const send = (ws, obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

server.on('upgrade', (req, socket, head) => {
  const deny = code => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch { return deny('400 Bad Request'); }
  const m = u.pathname.match(/^\/api\/n\/([^/]+)\/ws\/(logs|exec)\/([a-f0-9]{12,64})$/);
  if (!m) return deny('404 Not Found');
  req.originalUrl = req.url;
  let user = null, via = config.nodeId, role = 'viewer';
  const peerId = auth.verifyPeer(req);
  if (peerId) {
    user = String(req.headers['x-sc-user'] || `node:${peerId}`);
    via = String(req.headers['x-sc-via'] || peerId);
    const r = String(req.headers['x-sc-role'] || '');
    role = roles.isRole(r) ? r : 'viewer';
  } else {
    const origin = req.headers.origin;
    try { if (origin && new URL(origin).host !== req.headers.host) return deny('403 Forbidden'); } catch { return deny('403 Forbidden'); }
    const s = auth.sessionInfo(req);
    user = s?.u || null;
    role = roles.isRole(s?.r) ? s.r : 'admin';
  }
  if (!user) return deny('401 Unauthorized');
  if (!roles.atLeast(role, roles.requiredRole('WS', u.pathname))) return deny('403 Forbidden');
  const [, nodeId, kind, id] = m;
  wss.handleUpgrade(req, socket, head, ws => {
    if (nodeId === config.nodeId) return kind === 'logs' ? handleLogs(ws, id, u) : handleExec(ws, id, u, { user, via });
    if (peerId && req.headers['x-sc-hop']) { send(ws, { t: 'error', msg: 'Relay loop' }); return ws.close(); }
    const p = cluster.peer(nodeId);
    if (!p || !p.online) { send(ws, { t: 'error', msg: `${nodeId} is unreachable` }); return ws.close(); }
    relayWs(ws, p, req.url, user, role);
  });
});

function relayWs(client, p, url, user, role) {
  const upstream = new WebSocket(p.url.replace(/^http/, 'ws') + url, {
    headers: { ...auth.peerHeaders('GET', url), 'x-sc-user': user, 'x-sc-via': config.nodeId, 'x-sc-role': role, 'x-sc-hop': '1' },
    handshakeTimeout: 5000,
  });
  const queue = [];
  upstream.on('open', () => { for (const m of queue.splice(0)) upstream.send(m); });
  client.on('message', (m, bin) => { const data = bin ? m : m.toString(); if (upstream.readyState === WebSocket.OPEN) upstream.send(data); else queue.push(data); });
  upstream.on('message', (m, bin) => { if (client.readyState === WebSocket.OPEN) client.send(bin ? m : m.toString()); });
  const close = () => { try { client.close(); } catch { /* closed */ } try { upstream.terminate(); } catch { /* closed */ } };
  upstream.on('close', close);
  client.on('close', close);
  upstream.on('error', e => { send(client, { t: 'error', msg: `Relay to ${p.id} failed: ${e.message}` }); close(); });
}

async function handleLogs(ws, id, u) {
  const tail = Math.min(5000, Math.max(0, Number(u.searchParams.get('tail')) || 300));
  let stop = null;
  ws.on('close', () => stop?.());
  try {
    stop = await dockerApi.streamLogs(id, tail, lines => send(ws, { t: 'lines', lines }), () => { send(ws, { t: 'end' }); ws.close(); });
    if (ws.readyState !== WebSocket.OPEN) stop();
  } catch (e) {
    send(ws, { t: 'error', msg: e.json?.message || e.message });
    ws.close();
  }
}

async function handleExec(ws, id, u, w) {
  const cols = Number(u.searchParams.get('cols')) || 100, rows = Number(u.searchParams.get('rows')) || 30;
  let session;
  try {
    session = await dockerApi.openExec(id, u.searchParams.get('shell') || 'auto', cols, rows);
  } catch (e) {
    send(ws, { t: 'error', msg: e.json?.message || e.message });
    return ws.close();
  }
  const c = await dockerApi.findContainer(id).catch(() => null);
  audit.append({ who: w.user, via: w.via, msg: `Opened a shell in ${config.nodeId} / ${c?.name || id.slice(0, 12)}` });
  const { stream, exec, resize } = session;
  const { StringDecoder } = await import('node:string_decoder');
  const dec = new StringDecoder('utf8');
  stream.on('data', d => send(ws, { t: 'o', d: dec.write(d) }));
  stream.on('end', async () => {
    const code = await exec.inspect().then(i => i.ExitCode).catch(() => null);
    send(ws, { t: 'exit', code });
    ws.close();
  });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') stream.write(m.d);
    else if (m.t === 'r' && m.c > 0 && m.r > 0) resize(Math.min(500, m.c), Math.min(300, m.r));
  });
  ws.on('close', () => { try { stream.end(); stream.destroy(); } catch { /* closed */ } });
}

// ---------- Start ----------
const existingShared = cluster.getEntry('sharedEnv');
if (existingShared) await stacks.writeSharedEnv(existingShared.value);

server.listen(config.port, () => {
  console.log(`[selfcluster] ${config.nodeId} listening on :${config.port}, advertised as ${config.nodeUrl}`);
  console.log(`[selfcluster] new stacks go in ${config.stacksDir}, data in ${config.dataDir}, docker socket ${config.socket}`);
  console.log(stacks.hostRoot ? `[selfcluster] host filesystem at ${stacks.hostRoot}: stacks are found wherever they run` : '[selfcluster] no /host mount: only paths visible to this process can be read');
  if (config.peers.length) console.log(`[selfcluster] seed peers: ${config.peers.join(', ')}`);
});
// Seed only after the first round of heartbeats: a node joining an existing cluster gets the
// cluster's settings instead of pushing its own .env values.
cluster.start().then(async () => {
  let seeded = settings.seedFromEnv();
  if (!cluster.hasEntry('sharedEnv')) {
    const fromDisk = await stacks.readSharedEnvFile();
    if (fromDisk !== null) { cluster.setEntry('sharedEnv', fromDisk, `${config.nodeId} (disk)`); seeded = true; }
  }
  if (seeded) cluster.pushNow();
  if (!settings.configured()) console.warn('[selfcluster] no sign-in settings yet: add this node to a cluster from another node, or set ADMIN_PASSWORD in .env');
  const drift = settings.envDrift();
  if (drift.length) console.warn(`[selfcluster] .env differs from the cluster's sign-in settings (${drift.join(', ')}); the cluster's settings are used`);
  if (settings.oidc() && config.breakGlass) {
    console.warn(`[selfcluster] BREAK_GLASS is on: the admin password works on ${config.nodeId} despite single sign-on. Remove it from .env once you're done.`);
    audit.append({ who: 'system', msg: `Break-glass password sign-in enabled on ${config.nodeId}` });
  }
}).catch(e => console.error('[cluster]', e));
setInterval(dockerApi.pollStats, 10000);
dockerApi.pollStats();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cluster.flush(); stacks.flush(); server.close(); process.exit(0); });
