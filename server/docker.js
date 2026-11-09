// Docker Engine API access: containers, actions, stats, logs, exec and compose read-back.
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import YAML from 'yaml';
import { config } from './config.js';

export const docker = new Docker({ socketPath: config.socket });
const httpError = (status, message) => Object.assign(new Error(message), { status });

let info = null, infoAt = 0;
export async function engineInfo() {
  if (info && Date.now() - infoAt < 60e3) return info;
  const i = await docker.info();
  info = { engine: i.ServerVersion, os: i.OperatingSystem, cpus: i.NCPU, memTotal: i.MemTotal, hostname: i.Name };
  infoAt = Date.now();
  return info;
}

function formatPorts(ports = []) {
  const out = new Set();
  for (const p of ports) {
    if (!p.PublicPort) continue;
    out.add(`${p.PublicPort}:${p.PrivatePort}${p.Type && p.Type !== 'tcp' ? '/' + p.Type : ''}`);
  }
  return [...out];
}

const statsCache = new Map(); // full id -> { cpu, mem }

export async function listContainers() {
  const list = await docker.listContainers({ all: true });
  return list.map(c => {
    const L = c.Labels || {};
    const s = statsCache.get(c.Id);
    return {
      id: c.Id,
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created * 1000,
      ports: formatPorts(c.Ports),
      project: L['com.docker.compose.project'] || null,
      service: L['com.docker.compose.service'] || null,
      workdir: L['com.docker.compose.project.working_dir'] || null,
      configFiles: L['com.docker.compose.project.config_files'] || null,
      envFiles: L['com.docker.compose.project.environment_file'] || null,
      self: L['selfcluster.self'] === 'true',
      cpu: s ? s.cpu : null,
      mem: s ? s.mem : null,
    };
  });
}

function calcStats(s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const ncpu = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0;
  const m = s.memory_stats || {};
  const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? m.stats?.cache ?? 0;
  let rx = 0, tx = 0;
  for (const n of Object.values(s.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
  return { cpu: Math.round(cpu * 100) / 100, mem: Math.max(0, (m.usage || 0) - cache), memLimit: m.limit || 0, rx, tx, pids: s.pids_stats?.current ?? null };
}

export async function containerStats(id) {
  const ctr = docker.getContainer(id);
  const i = await ctr.inspect();
  const base = { restarts: i.RestartCount ?? 0, health: i.State?.Health?.Status || null, startedAt: i.State?.StartedAt || null, running: !!i.State?.Running, at: Date.now() };
  if (!i.State?.Running) return { ...base, cpu: 0, mem: 0, memLimit: 0, rx: 0, tx: 0, pids: 0 };
  const r = calcStats(await ctr.stats({ stream: false }));
  statsCache.set(i.Id, { cpu: r.cpu, mem: r.mem });
  return { ...base, ...r };
}

let polling = false;
export async function pollStats() {
  if (polling) return;
  polling = true;
  try {
    const ids = (await docker.listContainers({ all: false })).map(c => c.Id);
    for (const k of statsCache.keys()) if (!ids.includes(k)) statsCache.delete(k);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try { const r = calcStats(await docker.getContainer(id).stats({ stream: false })); statsCache.set(id, { cpu: r.cpu, mem: r.mem }); } catch { /* container went away */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    console.error('[stats]', e.message);
  } finally { polling = false; }
}

export function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e, out) => (e ? reject(e) : resolve(out)));
    });
  });
}

export async function containerAction(id, act) {
  const c = docker.getContainer(id);
  const tolerate304 = p => p.catch(e => { if (e.statusCode !== 304) throw e; });
  switch (act) {
    case 'start': return tolerate304(c.start());
    case 'stop': return tolerate304(c.stop({ t: 10 }));
    case 'restart': return c.restart({ t: 10 });
    case 'remove': return c.remove({ force: true });
    case 'pull': { const i = await c.inspect(); return pullImage(i.Config.Image); }
    default: throw httpError(400, `Unknown action "${act}"`);
  }
}

export async function findContainer(id) {
  return (await listContainers()).find(c => c.id === id || c.id.startsWith(id)) || null;
}

const SECRET_KEY = /(PASS|TOKEN|SECRET|KEY|PRIVATE|CREDENTIAL)/i;
export async function readback(id) {
  const i = await docker.getContainer(id).inspect();
  const name = i.Name.replace(/^\//, '');
  const svc = { image: i.Config.Image, container_name: name };
  const rp = i.HostConfig?.RestartPolicy?.Name;
  if (rp && rp !== 'no') svc.restart = rp;
  const ports = [];
  for (const [k, binds] of Object.entries(i.HostConfig?.PortBindings || {})) {
    for (const b of binds || []) ports.push(`${b.HostIp && b.HostIp !== '0.0.0.0' ? b.HostIp + ':' : ''}${b.HostPort}:${k.replace(/\/tcp$/, '')}`);
  }
  if (ports.length) svc.ports = ports;
  const vols = (i.Mounts || []).map(m => `${m.Type === 'volume' ? m.Name : m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`);
  if (vols.length) svc.volumes = vols;
  const envs = (i.Config.Env || [])
    .filter(e => !/^(PATH|HOME|HOSTNAME|TERM)=/.test(e))
    .map(e => { const k = e.split('=')[0]; return SECRET_KEY.test(k) ? `${k}=********` : e; });
  if (envs.length) svc.environment = envs;
  const nm = i.HostConfig?.NetworkMode;
  if (nm && !['default', 'bridge'].includes(nm)) svc.network_mode = nm;
  return `# Read back from docker inspect on ${config.nodeId}. This container is not managed by compose.\n# Values that look like secrets are masked.\n` + YAML.stringify({ services: { [name]: svc } });
}

// Follows a container's logs. Calls onLines with batches of { ts, s, l }. Returns a stop function.
export async function streamLogs(id, tail, onLines, onEnd) {
  const ctr = docker.getContainer(id);
  const i = await ctr.inspect();
  const stream = await ctr.logs({ follow: true, stdout: true, stderr: true, timestamps: true, tail });
  let batch = [], timer = null;
  const flush = () => { timer = null; if (batch.length) { onLines(batch); batch = []; } };
  const push = (raw, s) => {
    const sp = raw.indexOf(' ');
    const ts = sp > 0 ? Date.parse(raw.slice(0, sp)) : NaN;
    batch.push(Number.isNaN(ts) ? { ts: Date.now(), s, l: raw } : { ts, s, l: raw.slice(sp + 1) });
    if (batch.length >= 500) flush(); else if (!timer) timer = setTimeout(flush, 100);
  };
  const lineReader = s => {
    const dec = new StringDecoder('utf8');
    let buf = '';
    return chunk => {
      buf += dec.write(chunk);
      let n;
      while ((n = buf.indexOf('\n')) >= 0) { push(buf.slice(0, n).replace(/\r$/, ''), s); buf = buf.slice(n + 1); }
    };
  };
  if (i.Config.Tty) stream.on('data', lineReader('out'));
  else {
    const out = new PassThrough(), err = new PassThrough();
    docker.modem.demuxStream(stream, out, err);
    out.on('data', lineReader('out'));
    err.on('data', lineReader('err'));
  }
  stream.on('end', () => { flush(); onEnd?.(); });
  stream.on('error', () => { flush(); onEnd?.(); });
  return () => { clearTimeout(timer); stream.destroy(); };
}

const SHELLS = {
  auto: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
  '/bin/bash': ['/bin/bash'],
  '/bin/sh': ['/bin/sh'],
  '/bin/ash': ['/bin/ash'],
};
export async function openExec(id, shell, cols, rows) {
  const cmd = SHELLS[shell] || SHELLS.auto;
  const exec = await docker.getContainer(id).exec({
    Cmd: cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  const resize = (c, r) => exec.resize({ w: c, h: r }).catch(() => {});
  if (cols && rows) setTimeout(() => resize(cols, rows), 50);
  return { exec, stream, resize };
}
