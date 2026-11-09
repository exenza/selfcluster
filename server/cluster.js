// Cluster membership and replicated config.
//
// Each node is the only source of truth for its own containers and files, so the only state that
// needs replicating is small: the node list, shared.env and similar settings. Each config entry
// carries a counter (v), a timestamp and the user who wrote it; on merge the higher v wins, then
// the later timestamp. Nodes pull each other's state on every heartbeat and push on every write.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { peerHeaders } from './auth.js';
import * as audit from './audit.js';
import { writeSharedEnv } from './stacks.js';

const stateFile = path.join(config.dataDir, 'cluster.json');
const cacheDir = path.join(config.dataDir, 'cache');
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

let entries = {};
try { entries = JSON.parse(fs.readFileSync(stateFile, 'utf8')).entries || {}; } catch { /* first start */ }

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const tmp = `${stateFile}.tmp`;
    fsp.writeFile(tmp, JSON.stringify({ entries }, null, 1), { mode: 0o600 }).then(() => fsp.rename(tmp, stateFile)).catch(e => console.error('[cluster] persist', e.message));
  }, 100);
}
// Called on shutdown (docker stop sends SIGTERM) so the last changes aren't lost.
export function flush() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ entries }, null, 1), { mode: 0o600 });
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  } catch (e) { console.error('[cluster] flush', e.message); }
}

const hooks = { sharedEnv: v => writeSharedEnv(v ?? '') };

// Sign-in settings carry secrets (client secret, password hash). They are encrypted with a key
// derived from CLUSTER_SECRET, in cluster.json on every node and on the wire between nodes.
const SEALED = k => k.startsWith('auth.');
// Keys where two edits made without seeing each other are worth flagging.
const GUARDED = k => k === 'sharedEnv' || k.startsWith('auth.');
const sealKey = crypto.createHash('sha256').update('selfcluster-config\0' + config.secret).digest();
function seal(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value ?? null), 'utf8'), c.final()]);
  return { enc: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
}
function unseal(v) {
  if (!v || typeof v.enc !== 'string') return v;
  const b = Buffer.from(v.enc, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

export const entryId = e => crypto.createHash('sha256').update(`${e.v}\n${e.ts}\n${e.by}`).digest('hex').slice(0, 12);
const HISTORY = 30;

function isNewer(a, b) {
  if (!b) return true;
  if (a.v !== b.v) return a.v > b.v;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return String(a.by) > String(b.by);
}

// Unconditional local write. Each version remembers the ids of the versions it replaced, so a
// merge can tell "newer edit of the same thing" from "two edits made without seeing each other".
export function setEntry(key, value, by, deleted = false) {
  const cur = entries[key];
  const e = {
    v: (cur?.v || 0) + 1, ts: Date.now(), by, node: config.nodeId,
    value: deleted ? null : SEALED(key) ? seal(value) : value,
    hist: cur ? [entryId(cur), ...(cur.hist || [])].slice(0, HISTORY) : [],
    ...(deleted ? { deleted: true } : {}),
  };
  entries[key] = e;
  persist();
  hooks[key]?.(deleted ? undefined : value);
  return e;
}
const open = e => {
  if (!e || e.deleted) return null;
  try { return { ...e, value: unseal(e.value) }; } catch (err) {
    console.error('[cluster] cannot decrypt a config entry (CLUSTER_SECRET differs?)', err.message);
    return null;
  }
};
export function getEntry(key) { return open(entries[key]); }
export const hasEntry = key => !!entries[key];

function recordCollision(key, winner, loser) {
  const ck = `conflict:${key}:${entryId(loser)}`;
  if (entries[ck]) return;
  entries[ck] = { v: 1, ts: Date.now(), by: 'system', hist: [], value: { key, loser, winner: entryId(winner), winnerBy: winner.by, winnerNode: winner.node || null, winnerTs: winner.ts } };
  audit.append({ who: 'system', msg: `Two changes to ${key} were made without seeing each other (${loser.by} on ${loser.node || '?'}, ${winner.by} on ${winner.node || '?'}). Kept the one from ${winner.node || winner.by}; review it in Settings.` });
}

export function merge(remote) {
  let changed = false;
  for (const [k, e] of Object.entries(remote || {})) {
    if (!e || typeof e.v !== 'number' || typeof e.ts !== 'number') continue;
    if (k.startsWith('node:') && !e.deleted && (typeof e.value?.url !== 'string' || !/^https?:\/\//.test(e.value.url))) continue;
    const local = entries[k];
    if (local && entryId(local) === entryId(e)) continue;
    if (local && GUARDED(k) && Array.isArray(e.hist) && Array.isArray(local.hist)
      && !e.hist.includes(entryId(local)) && !local.hist.includes(entryId(e))) {
      const remoteWins = isNewer(e, local);
      recordCollision(k, remoteWins ? e : local, remoteWins ? local : e);
      changed = true;
    }
    if (!isNewer(e, local)) continue;
    entries[k] = e;
    changed = true;
    if (hooks[k]) { const o = open(e); hooks[k](o ? o.value : undefined); }
  }
  if (changed) persist();
  return changed;
}
export const allEntries = () => entries;
export const version = () => Object.entries(entries).filter(([k]) => !k.startsWith('conflict:')).reduce((a, [, e]) => a + e.v, 0);
export function digest() {
  const s = Object.keys(entries).sort().map(k => `${k}:${entries[k].v}:${entries[k].ts}:${entries[k].by}`).join('|');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}
export function collisions() {
  return Object.entries(entries).filter(([k, e]) => k.startsWith('conflict:') && !e.deleted).map(([id, e]) => ({ id, ...e.value }));
}
export function openLoser(c) { return open(c.loser); }

// ---------- Conditional writes ----------
// A guarded write first asks every reachable node "are you still at the version I started from?"
// and reserves the key there for a few seconds. Only if all agree is the new version written and
// pushed. Nodes that can't be reached are caught later by the collision check in merge().
const reservations = new Map();
export function reserve(key, baseId, token) {
  const r = reservations.get(key);
  if (r && r.until > Date.now() && r.token !== token) return { ok: false, busy: true };
  const cur = entries[key];
  if ((cur ? entryId(cur) : null) !== baseId) return { ok: false, current: cur || null };
  reservations.set(key, { token, until: Date.now() + 5000 });
  return { ok: true };
}
export function release(key, token) { if (reservations.get(key)?.token === token) reservations.delete(key); }

export async function writeGuarded(key, value, by, baseV) {
  for (let attempt = 0; ; attempt++) {
    try { return await writeGuardedOnce(key, value, by, baseV); } catch (e) {
      if (!e.busy || attempt >= 4) throw e;
      // Back off for a random 100-400 ms: the other save usually finishes, and then this one
      // fails properly with "changed by …" because its base version moved on.
      await new Promise(r => setTimeout(r, 100 + Math.random() * 300));
    }
  }
}
async function writeGuardedOnce(key, value, by, baseV) {
  const conflict = (msg, extra = {}) => Object.assign(new Error(msg), { status: 409, ...extra });
  const cur = entries[key];
  if ((cur?.v || 0) !== Number(baseV || 0)) throw conflict(`This was changed by ${cur?.by || 'someone'} after you opened it`, { current: getEntry(key) });
  const baseId = cur ? entryId(cur) : null;
  const token = crypto.randomUUID();
  const mine = reserve(key, baseId, token);
  if (!mine.ok) throw conflict('Someone is saving this right now. Try again in a moment.', { busy: true });
  const online = nodeList().filter(n => !n.self && n.online);
  const answers = await Promise.all(online.map(n =>
    signedFetch(n.url, '/peer/prepare', { method: 'POST', body: { key, baseId, token }, timeout: 3000 })
      .then(async r => ({ n, ok: r.ok, body: await r.json().catch(() => ({})) }))
      .catch(() => ({ n, ok: null }))));
  const refused = answers.filter(a => a.ok === false);
  if (refused.length) {
    release(key, token);
    for (const a of answers.filter(x => x.ok)) signedFetch(a.n.url, '/peer/release', { method: 'POST', body: { key, token } }).catch(() => {});
    const newer = refused.find(a => a.body?.current)?.body.current;
    if (newer) merge({ [key]: newer });
    throw newer
      ? conflict(`${refused.map(a => a.n.id).join(', ')} already has a newer version, saved by ${newer.by}`, { current: getEntry(key) })
      : conflict(`${refused.map(a => a.n.id).join(', ')} is saving this right now. Try again in a moment.`, { busy: true });
  }
  const e = setEntry(key, value, by);
  release(key, token);
  await Promise.all(answers.filter(a => a.ok !== false).map(a =>
    signedFetch(a.n.url, '/peer/commit', { method: 'POST', body: { key, token, entries: { [key]: e } } }).catch(() => {})));
  return getEntry(key);
}

// ---------- Peers ----------
const peers = new Map();   // id -> last state reported by that node, plus url/latency/lastSeen
const urlToId = new Map(); // url -> id (null when the url turned out to be this node)
const isOnline = p => !!p && Date.now() - (p.lastSeen || 0) < config.offlineAfterMs;

function knownUrls() {
  const urls = new Set(config.peers);
  for (const [k, e] of Object.entries(entries)) {
    if (k.startsWith('node:') && !e.deleted && k !== `node:${config.nodeId}`) urls.add(e.value.url);
  }
  urls.delete(config.nodeUrl);
  for (const [u, id] of urlToId) if (id === null) urls.delete(u);
  return [...urls];
}

export function nodeList() {
  const out = new Map();
  out.set(config.nodeId, { id: config.nodeId, url: config.nodeUrl, self: true, online: true });
  for (const [k, e] of Object.entries(entries)) {
    if (!k.startsWith('node:') || e.deleted) continue;
    const id = k.slice(5);
    if (id !== config.nodeId) out.set(id, { id, url: e.value.url, self: false, online: false, lastSeen: 0 });
  }
  for (const [id, p] of peers) {
    if (id === config.nodeId || entries[`node:${id}`]?.deleted) continue;
    out.set(id, { ...out.get(id), ...p, id, self: false, online: isOnline(p) });
  }
  for (const u of config.peers) {
    if (u === config.nodeUrl || urlToId.has(u) || [...out.values()].some(n => n.url === u)) continue;
    out.set(u, { id: u, url: u, self: false, online: false, lastSeen: 0, neverSeen: true });
  }
  return [...out.values()];
}
export function peer(id) { return nodeList().find(n => !n.self && n.id === id) || null; }

export function signedFetch(baseUrl, pathname, { method = 'GET', headers = {}, body, timeout = 4000 } = {}) {
  return fetch(baseUrl + pathname, {
    method,
    headers: { ...peerHeaders(method, pathname), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
}

async function beat(url) {
  const t0 = performance.now();
  try {
    const r = await signedFetch(url, '/peer/state', { timeout: 3000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? ' (CLUSTER_SECRET differs?)' : ''}`);
    const s = await r.json();
    if (!SAFE_ID.test(s.id || '')) throw new Error('Peer sent an invalid node id');
    if (s.id === config.nodeId) { urlToId.set(url, null); return; }
    urlToId.set(url, s.id);
    const first = !peers.has(s.id) || !isOnline(peers.get(s.id));
    peers.set(s.id, { ...s, entries: undefined, url: s.url || url, latency: Math.round(performance.now() - t0), lastSeen: Date.now(), error: null });
    merge(s.entries);
    // The peer may not know about us yet (we found it through PEERS), so push what we have.
    if (s.digest !== digest()) signedFetch(url, '/peer/merge', { method: 'POST', body: { entries } }).catch(() => {});
    if (first) snapshot(s.id);
  } catch (e) {
    const id = urlToId.get(url);
    const p = id && peers.get(id);
    if (p) p.error = e.cause?.code || e.message;
  }
}

const reported = new Map();
function noteTransitions() {
  for (const n of nodeList()) {
    if (n.self || n.neverSeen) continue;
    const prev = reported.get(n.id);
    if (prev !== undefined && prev !== n.online) {
      audit.append({ who: 'system', msg: n.online ? `${n.id} is reachable again` : `${n.id} stopped answering heartbeats` });
    }
    reported.set(n.id, n.online);
  }
}

// Every node keeps a copy of each peer's inventory and stack files, so an offline node can still
// be read and its stacks redeployed elsewhere.
async function snapshot(id) {
  const p = peers.get(id);
  if (!p || !SAFE_ID.test(id)) return;
  try {
    const r = await signedFetch(p.url, '/peer/snapshot', { timeout: 15000 });
    if (!r.ok) return;
    const body = await r.text();
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(path.join(cacheDir, `${id}.json`), body, { mode: 0o600 });
  } catch { /* try again next round */ }
}
export async function cached(id) {
  if (!SAFE_ID.test(id)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(cacheDir, `${id}.json`), 'utf8')); } catch { return null; }
}

export async function pushNow() {
  await Promise.all(nodeList().filter(n => !n.self && n.online).map(n =>
    signedFetch(n.url, '/peer/merge', { method: 'POST', body: { entries } }).catch(() => {})));
}

// Adds a node by address. The node must already run SelfCluster with this cluster's CLUSTER_SECRET;
// it doesn't need PEERS. Once its entry is in the replicated node list, every node heartbeats it
// and it learns the full list from the push below.
export async function addNode(rawUrl, by) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { throw fail(400, 'Enter the node\'s address, for example http://192.168.1.30:7443'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail(400, 'The address must start with http:// or https://');
  const typed = u.origin;

  const probe = async url => {
    const t0 = performance.now();
    let r;
    try { r = await signedFetch(url, '/peer/state', { timeout: 5000 }); } catch (e) {
      throw fail(502, `Couldn't reach ${url} from ${config.nodeId}: ${e.cause?.code || e.message}. Is SelfCluster running there, and is the port open?`);
    }
    if (r.status === 401 || r.status === 403) throw fail(400, `${url} answered but refused this cluster's signature: its CLUSTER_SECRET is different. Copy the secret from this node's .env and restart SelfCluster there.`);
    if (!r.ok) throw fail(502, `${url} answered with HTTP ${r.status}. Is that a SelfCluster node?`);
    const s = await r.json().catch(() => null);
    if (!s || !SAFE_ID.test(s.id || '') || typeof s.url !== 'string') throw fail(502, `${url} didn't answer like a SelfCluster node`);
    return { s, latency: Math.round(performance.now() - t0) };
  };

  let { s, latency } = await probe(typed);
  if (s.id === config.nodeId) throw fail(409, `${typed} is ${config.nodeId} itself`);
  const live = peers.get(s.id);
  if (live && isOnline(live) && live.url !== s.url) throw fail(409, `A node named ${s.id} is already in the cluster at ${live.url}. Give the new machine a different NODE_ID.`);
  // Store the address the node advertises (its NODE_URL): that is what it re-announces on every restart.
  if (s.url !== typed) {
    try { ({ s, latency } = await probe(s.url)); } catch {
      throw fail(409, `${s.id} answered at ${typed}, but its NODE_URL says ${s.url}, which ${config.nodeId} can't reach. Set NODE_URL=${typed} in its .env and restart SelfCluster there.`);
    }
  }

  merge(s.entries);
  const cur = entries[`node:${s.id}`];
  if (!cur || cur.deleted || cur.value?.url !== s.url) setEntry(`node:${s.id}`, { url: s.url }, by);
  urlToId.set(s.url, s.id);
  peers.set(s.id, { ...s, entries: undefined, latency, lastSeen: Date.now(), error: null });
  await signedFetch(s.url, '/peer/merge', { method: 'POST', body: { entries } }).catch(() => {});
  pushNow();
  snapshot(s.id);
  return { id: s.id, url: s.url };
}

export async function forget(id, by) {
  const n = peer(id);
  if (!n) throw Object.assign(new Error(`Unknown node ${id}`), { status: 404 });
  if (n.online) throw Object.assign(new Error(`${id} is online. Stop SelfCluster on it before removing it from the cluster.`), { status: 409 });
  setEntry(`node:${id}`, null, by, true);
  peers.delete(id);
  for (const [u, v] of urlToId) if (v === id) urlToId.delete(u);
  if (SAFE_ID.test(id)) await fsp.rm(path.join(cacheDir, `${id}.json`), { force: true });
  pushNow();
}

export async function start() {
  // Load peers known from earlier runs so offline nodes still show up with their cached data.
  try {
    for (const f of await fsp.readdir(cacheDir)) {
      const id = f.replace(/\.json$/, '');
      if (!SAFE_ID.test(id) || id === config.nodeId || entries[`node:${id}`]?.deleted) continue;
      const c = await cached(id);
      if (c && !peers.has(id)) peers.set(id, { id, url: entries[`node:${id}`]?.value?.url || c.url, lastSeen: c.at || 0, agent: c.agent, host: c.host, error: 'not contacted since restart' });
    }
  } catch { /* no cache yet */ }

  const mine = entries[`node:${config.nodeId}`];
  if (!mine || mine.deleted || mine.value?.url !== config.nodeUrl) setEntry(`node:${config.nodeId}`, { url: config.nodeUrl }, 'system');

  const tick = async () => { await Promise.all(knownUrls().map(beat)); noteTransitions(); };
  await tick();
  setInterval(tick, config.heartbeatMs);
  setInterval(() => { for (const n of nodeList()) if (!n.self && n.online) snapshot(n.id); }, config.snapshotMs);
}
