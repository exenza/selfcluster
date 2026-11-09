// Compose stacks on this node, wherever their files live.
//
// Stacks are discovered from the labels docker compose puts on every container (project name,
// working directory, compose files, --env-file), remembered after they stop, and also found by
// scanning STACKS_DIR. Files are read and written through the host filesystem mounted at /host,
// and `docker compose` runs against each project's real host path, mapped into this container.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { config } from './config.js';

const P = path.posix;
export const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
export const STACK_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_RE = /^(?:\.env|[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}\.env)$/;
export const SHARED_ENV = 'shared.env';

export const etag = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------- Host filesystem ----------
// In the container the host's / is mounted at /host. Run outside a container (development),
// HOST_ROOT is empty and paths are used as they are.
const HOST_ROOT = (() => {
  const r = (process.env.HOST_ROOT ?? '/host').replace(/\/+$/, '');
  try { if (r && fss.statSync(r).isDirectory()) return r; } catch { /* not mounted */ }
  return '';
})();
export const hostRoot = HOST_ROOT;
const norm = p => P.resolve('/', String(p));
export const hp = p => (HOST_ROOT ? P.join(HOST_ROOT, norm(p)) : norm(p));
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };
const fileId = p => crypto.createHash('sha1').update(norm(p)).digest('hex').slice(0, 12);
async function sameFile(a, b) {
  try { const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}

// `docker compose` resolves relative paths (./config, ../shared.env) and hands them to the engine as
// host paths, so each project folder must exist inside this container at its real host path.
// We get there with a symlink to /host/<path>, placed as high up the path as possible.
const RESERVED = new Set(['/', '/app', '/data', '/host', '/proc', '/sys', '/dev', '/run', '/tmp', '/var', '/etc', '/usr', '/lib', '/bin', '/sbin', '/root']);
async function isMountPoint(p) {
  try { const [a, b] = await Promise.all([fs.stat(p), fs.stat(P.dirname(p))]); return a.dev !== b.dev; } catch { return false; }
}
export async function ensureMapped(dir) {
  if (!HOST_ROOT || !dir) return;
  dir = norm(dir);
  if (await sameFile(dir, hp(dir))) return;
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) {
    const next = `${cur}/${part}`;
    const target = P.join(HOST_ROOT, next);
    const st = await fs.lstat(next).catch(() => null);
    const link = async () => {
      try { await fs.symlink(target, next); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    };
    if (!st) { await link(); break; }
    if (st.isSymbolicLink()) {
      if ((await fs.readlink(next)) === target) break;
      throw httpError(409, `Can't map ${dir}: ${next} is already used inside SelfCluster's container`);
    }
    if (st.isDirectory() && !RESERVED.has(next) && !(await isMountPoint(next)) && (await fs.readdir(next)).length === 0) {
      await fs.rmdir(next);
      await link();
      break;
    }
    if (await sameFile(next, target)) break;
    cur = next;
  }
  if (!(await sameFile(dir, hp(dir)))) {
    throw httpError(409, `Can't run docker compose for ${dir}: that path collides with a folder inside SelfCluster's own container (${cur || '/'}). Move the stack somewhere else.`);
  }
}

// ---------- Registry of known projects ----------
const registryFile = path.join(config.dataDir, 'projects.json');
const metaFile = path.join(config.dataDir, 'file-meta.json');
let meta = {};
try { meta = JSON.parse(fss.readFileSync(metaFile, 'utf8')); } catch { /* first start */ }
let registry = {};
try { registry = JSON.parse(fss.readFileSync(registryFile, 'utf8')); } catch { /* first start */ }
let regTimer = null;
function saveRegistry() {
  clearTimeout(regTimer);
  regTimer = setTimeout(() => {
    const tmp = `${registryFile}.tmp`;
    fs.writeFile(tmp, JSON.stringify(registry, null, 1)).then(() => fs.rename(tmp, registryFile)).catch(e => console.error('[stacks] registry', e.message));
  }, 200);
}
export function flush() {
  if (regTimer) { clearTimeout(regTimer); regTimer = null; try { fss.writeFileSync(registryFile, JSON.stringify(registry, null, 1)); } catch (e) { console.error('[stacks] flush', e.message); } }
  try { fss.writeFileSync(metaFile, JSON.stringify(meta)); } catch { /* nothing to write */ }
}
const sameList = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);
function parsePaths(label, base) {
  return String(label || '').split(',').map(s => s.trim()).filter(Boolean).map(f => (P.isAbsolute(f) ? norm(f) : norm(P.join(base || '/', f))));
}

function learn(ctrs) {
  const now = Date.now();
  let changed = false;
  for (const c of ctrs) {
    if (!c.project || !STACK_RE.test(c.project)) continue;
    const dir = c.workdir ? norm(c.workdir) : null;
    const prev = registry[c.project];
    const cfg = parsePaths(c.configFiles, dir);
    const envs = parsePaths(c.envFiles, dir);
    const next = {
      name: c.project,
      dir: dir || prev?.dir || null,
      configFiles: cfg.length ? cfg : prev?.configFiles || [],
      envFiles: envs.length ? envs : prev?.envFiles || [],
      source: prev?.source || 'running',
      firstSeen: prev?.firstSeen || now,
    };
    if (!prev || prev.dir !== next.dir || !sameList(prev.configFiles, next.configFiles) || !sameList(prev.envFiles, next.envFiles)) {
      registry[c.project] = next;
      changed = true;
    }
  }
  if (changed) saveRegistry();
}

async function composeIn(dir) {
  for (const n of COMPOSE_NAMES) if (await exists(hp(P.join(dir, n)))) return P.join(dir, n);
  return null;
}
async function projectNameOf(file, fallback) {
  try {
    const doc = YAML.parse(await fs.readFile(hp(file), 'utf8'));
    if (doc && typeof doc.name === 'string' && STACK_RE.test(doc.name)) return doc.name;
  } catch { /* fall back to the folder name */ }
  return STACK_RE.test(fallback) ? fallback : null;
}

// Folders under STACKS_DIR that have a compose file but were never seen running.
async function scanStacksDir() {
  let entries;
  try { entries = await fs.readdir(hp(config.stacksDir), { withFileTypes: true }); } catch { return; }
  const knownDirs = new Set(Object.values(registry).map(e => e.dir));
  let changed = false;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = P.join(config.stacksDir, e.name);
    if (knownDirs.has(dir)) continue;
    const file = await composeIn(dir);
    if (!file) continue;
    const name = await projectNameOf(file, e.name.toLowerCase());
    if (!name || registry[name]) continue;
    registry[name] = { name, dir, configFiles: [file], envFiles: [], source: 'folder', firstSeen: Date.now() };
    changed = true;
  }
  if (changed) saveRegistry();
}

export async function listStacks(ctrs) {
  learn(ctrs);
  await scanStacksDir();
  const out = [];
  for (const e of Object.values(registry)) {
    const primary = e.configFiles[0] || (e.dir && (await composeIn(e.dir)));
    out.push({
      name: e.name, dir: e.dir, source: e.source,
      composeFile: primary ? P.basename(primary) : null,
      composeFiles: e.configFiles,
      filesMissing: !primary || !(await exists(hp(primary))),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function entry(name) {
  if (!STACK_RE.test(name)) throw httpError(400, 'Stack names use lowercase letters, digits, "-" and "_"');
  const e = registry[name];
  if (!e) throw httpError(404, `There is no stack "${name}" on ${config.nodeId}`);
  return e;
}

// Every file SelfCluster may read or write for a stack: its compose files, plus env files from
// --env-file, from env_file: in the compose files, and *.env files in the project folder.
async function stackFiles(e) {
  const compose = e.configFiles.length ? [...e.configFiles] : [];
  if (!compose.length && e.dir) { const f = await composeIn(e.dir); if (f) compose.push(f); }
  const env = new Set(e.envFiles);
  if (e.dir) {
    try { for (const f of await fs.readdir(hp(e.dir))) if (ENV_RE.test(f)) env.add(P.join(e.dir, f)); } catch { /* folder missing */ }
  }
  for (const cf of compose) {
    let doc;
    try { doc = YAML.parse(await fs.readFile(hp(cf), 'utf8')); } catch { continue; }
    for (const svc of Object.values(doc?.services || {})) {
      const refs = svc?.env_file == null ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
      for (const r of refs) {
        const rel = typeof r === 'string' ? r : r?.path;
        if (typeof rel !== 'string' || rel.includes('${')) continue;
        const abs = P.isAbsolute(rel) ? norm(rel) : norm(P.join(e.dir || P.dirname(cf), rel));
        if (await exists(hp(abs))) env.add(abs);
      }
    }
  }
  for (const c of compose) env.delete(c);
  return { compose, env: [...env] };
}

const saveMeta = () => fs.writeFile(metaFile, JSON.stringify(meta)).catch(() => {});

function labelFor(e, p) {
  if (!e.dir) return p;
  const rel = P.relative(e.dir, p);
  return rel.startsWith('../../') ? p : rel;
}
async function readOne(e, p, kind) {
  const [content, st] = await Promise.all([fs.readFile(hp(p), 'utf8'), fs.stat(hp(p))]);
  return { id: fileId(p), name: P.basename(p), label: labelFor(e, p), path: p, kind, content, etag: etag(content), mtime: st.mtimeMs, modified: meta[p] || null };
}

export async function readFiles(name) {
  const e = entry(name);
  const f = await stackFiles(e);
  if (!f.compose.length) throw httpError(404, `No compose file is known for ${name}`);
  let primary;
  try { primary = await readOne(e, f.compose[0], 'compose'); } catch {
    throw httpError(404, `Can't read ${f.compose[0]} on ${config.nodeId}. The files may have been moved or deleted.`);
  }
  const others = [];
  for (const p of f.env) { try { others.push(await readOne(e, p, 'env')); } catch { /* unreadable */ } }
  others.sort((a, b) => (a.label === '.env' ? -1 : b.label === '.env' ? 1 : a.label.localeCompare(b.label)));
  for (const p of f.compose.slice(1)) { try { others.push(await readOne(e, p, 'compose')); } catch { /* unreadable */ } }
  return { stack: name, dir: e.dir, compose: primary, env: others };
}

export function validateYaml(content) {
  const doc = YAML.parseDocument(content);
  if (doc.errors.length) {
    const err = doc.errors[0];
    const line = err.linePos?.[0]?.line;
    throw httpError(400, `${line ? `Line ${line}: ` : ''}${err.message.split('\n')[0]}`);
  }
  const obj = doc.toJS();
  if (!obj || typeof obj !== 'object') throw httpError(400, 'The file is empty or not a YAML mapping');
}

async function backup(name, p, content) {
  const dir = path.join(config.dataDir, 'history', name);
  await fs.mkdir(dir, { recursive: true });
  const base = P.basename(p);
  await fs.writeFile(path.join(dir, `${base}.${Date.now()}`), content, { mode: 0o600 });
  const old = (await fs.readdir(dir)).filter(f => f.startsWith(`${base}.`) && /^\d+$/.test(f.slice(base.length + 1))).sort();
  for (const f of old.slice(0, -20)) await fs.rm(path.join(dir, f)).catch(() => {});
}

// `key` is a file id from readFiles, or the name of a new .env file to create in the project folder.
export async function writeFile(name, key, content, baseEtag, who) {
  const e = entry(name);
  if (typeof content !== 'string' || content.length > 1_000_000) throw httpError(400, 'File content is missing or larger than 1 MB');
  const f = await stackFiles(e);
  const all = [...f.compose.map(p => [p, 'compose']), ...f.env.map(p => [p, 'env'])];
  let hit = all.find(([p]) => fileId(p) === key);
  if (!hit && ENV_RE.test(key) && e.dir) {
    const p = P.join(e.dir, key);
    hit = all.find(([q]) => q === p) || [p, 'env'];
  }
  if (!hit) throw httpError(404, 'That file is not part of this stack');
  const [p, kind] = hit;
  let current = null, mode = kind === 'compose' ? 0o644 : 0o640;
  try { current = await fs.readFile(hp(p), 'utf8'); mode = (await fs.stat(hp(p))).mode & 0o777; } catch { /* new file */ }
  if (current !== null && etag(current) !== baseEtag) {
    throw httpError(409, `${P.basename(p)} changed on ${config.nodeId} after you opened it`, { current: await readOne(e, p, kind) });
  }
  if (current === null && baseEtag) throw httpError(409, `${P.basename(p)} was deleted on ${config.nodeId}`, { current: null });
  if (kind === 'compose') validateYaml(content);
  if (current !== null) await backup(name, p, current);
  const tmp = `${hp(p)}.selfcluster-tmp`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, hp(p));
  meta[p] = { by: who.user, via: who.via, at: Date.now() };
  saveMeta();
  return readOne(e, p, kind);
}

export async function createStack(name, files, who) {
  if (!STACK_RE.test(name)) throw httpError(400, 'Stack names use lowercase letters, digits, "-" and "_"');
  if (registry[name]) throw httpError(409, `A stack named "${name}" already exists on ${config.nodeId}`);
  const dir = P.join(config.stacksDir, name);
  if (await composeIn(dir)) throw httpError(409, `${dir} already has a compose file`);
  const list = Array.isArray(files) ? files : [];
  const compose = list.find(f => COMPOSE_NAMES.includes(f.name));
  if (!compose) throw httpError(400, 'A new stack needs a compose.yaml file');
  validateYaml(compose.content);
  for (const f of list) if (!COMPOSE_NAMES.includes(f.name) && !ENV_RE.test(f.name)) throw httpError(400, `Unsupported file name "${f.name}"`);
  await fs.mkdir(hp(dir), { recursive: true });
  for (const f of list) {
    const p = P.join(dir, f.name);
    await fs.writeFile(hp(p), f.content, { mode: f.name === compose.name ? 0o644 : 0o640 });
    meta[p] = { by: who.user, via: who.via, at: Date.now() };
  }
  saveMeta();
  registry[name] = { name, dir, configFiles: [P.join(dir, compose.name)], envFiles: [], source: 'created', firstSeen: Date.now() };
  saveRegistry();
  return readFiles(name);
}

export function forgetStack(name) {
  entry(name);
  delete registry[name];
  saveRegistry();
}

function run(args, { cwd, input, timeoutMs = 15 * 60e3 } = {}) {
  return new Promise(resolve => {
    // A clean environment: compose lets the shell environment override a stack's .env when it
    // interpolates ${VARS}, so SelfCluster's own settings (PORT, NODE_ID, secrets) must not leak in.
    const child = spawn('docker', args, {
      cwd,
      env: {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        DOCKER_HOST: `unix://${config.socket}`,
        COMPOSE_ANSI: 'never',
        COMPOSE_PROGRESS: 'plain',
      },
    });
    let out = '';
    const add = d => { out += d.toString(); if (out.length > 200_000) out = out.slice(-200_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { child.kill('SIGTERM'); add('\n[selfcluster] timed out\n'); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ code: 127, out: `Could not run docker: ${e.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

async function prepare(e) {
  const f = await stackFiles(e);
  if (!f.compose.length || !e.dir || !(await exists(hp(f.compose[0])))) {
    throw httpError(409, `The files for ${e.name} are missing on ${config.nodeId} (${f.compose[0] || e.dir || 'unknown folder'})`);
  }
  const dirs = new Set([e.dir, ...[...f.compose, ...f.env, ...e.envFiles].map(p => P.dirname(p))]);
  for (const d of dirs) await ensureMapped(d);
  return f;
}

// Runs docker compose exactly the way the project was started: same project name, folder,
// compose files (-f) and --env-file.
export async function compose(name, op) {
  const e = entry(name);
  const ops = { up: ['up', '-d', '--remove-orphans'], down: ['down'], pull: ['pull'] };
  if (!ops[op]) throw httpError(400, `Unknown compose operation "${op}"`);
  return withLock(name, async () => {
    const f = await prepare(e);
    const args = ['compose', '-p', name, '--project-directory', e.dir,
      ...f.compose.flatMap(p => ['-f', p]), ...e.envFiles.flatMap(p => ['--env-file', p]), ...ops[op]];
    const r = await run(args, { cwd: e.dir });
    if (r.code !== 0) throw httpError(500, `docker compose ${op} failed for ${name}`, { output: r.out });
    return r.out;
  });
}

export async function composeValidate(name, content) {
  validateYaml(content);
  const e = entry(name);
  await prepare(e);
  const r = await run(['compose', '-p', name, '--project-directory', e.dir, ...e.envFiles.flatMap(p => ['--env-file', p]), '-f', '-', 'config', '--quiet'], { cwd: e.dir, input: content, timeoutMs: 30e3 });
  if (r.code !== 0) throw httpError(400, r.out.trim().split('\n').slice(-3).join(' ') || 'docker compose rejected the file');
}

export const sharedEnvPath = () => P.join(config.stacksDir, SHARED_ENV);
export async function writeSharedEnv(content) {
  try {
    await fs.mkdir(hp(config.stacksDir), { recursive: true });
    await fs.writeFile(hp(sharedEnvPath()), content ?? '', { mode: 0o640 });
  } catch (e) { console.error('[shared.env]', e.message); }
}
export async function readSharedEnvFile() {
  try { return await fs.readFile(hp(sharedEnvPath()), 'utf8'); } catch { return null; }
}
