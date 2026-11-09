(() => {
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}
const hhmm = t => new Date(t).toTimeString().slice(0, 5);
function bytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'selfcluster' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && !opts.quiet401) showLogin();
  if (!r.ok) throw Object.assign(new Error(data?.error || `Request failed (HTTP ${r.status})`), { status: r.status, data });
  return data;
}
const N = (node, p) => `/api/n/${enc(node)}${p}`;
const wsUrl = p => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;

/* ---------- State ---------- */
const defaults = { tree: 'servers', theme: 'system', density: 'comfortable', side: '290', status: 'meta', envpos: 'below', inspect: 'stacked', font: '13', wrap: 'nowrap', stats: 'show' };
let opts = { ...defaults };
try { Object.assign(opts, JSON.parse(localStorage.getItem('selfcluster-ui') || '{}')); } catch { /* storage blocked */ }
let openSaved = null;
try { openSaved = JSON.parse(localStorage.getItem('selfcluster-open') || 'null'); } catch { /* storage blocked */ }

const state = {
  me: null, cluster: null, overview: [], nodes: [], nodeInfo: new Map(), ctrs: [], byUid: new Map(), stacks: [],
  sel: null, tab: 'compose', view: 'container', focusNode: null,
  open: new Set(openSaved || []), openTouched: !!openSaved,
  filter: 'all', q: '', srv: 'all', pickSrv: null, follow: true, paused: false, loaded: false,
};
const docs = new Map();
let shared = { value: '', v: 0, by: null, ts: null, edit: null, conflict: null };
const saveOpen = () => { try { localStorage.setItem('selfcluster-open', JSON.stringify([...state.open])); } catch { /* ignore */ } };

/* ---------- Model ---------- */
function rebuild(ov) {
  state.overview = ov;
  state.nodes = ov.map(n => n.node).sort((a, b) => (a === state.me?.node ? -1 : b === state.me?.node ? 1 : a.localeCompare(b)));
  state.nodeInfo = new Map(ov.map(n => [n.node, n]));
  const ctrs = [], stacks = [];
  for (const n of ov) {
    for (const s of n.stacks || []) {
      const list = s.containers.map(c => mk(c, n.node, s.name, !!s.filesMissing));
      ctrs.push(...list);
      stacks.push({ srv: n.node, id: s.name, dir: s.dir, external: !!s.filesMissing, self: !!s.self, containers: list });
    }
    for (const c of n.standalone || []) ctrs.push(mk(c, n.node, null, false));
  }
  state.ctrs = ctrs;
  state.stacks = stacks;
  state.byUid = new Map(ctrs.map(c => [c.uid, c]));
  if (!state.openTouched) {
    for (const id of state.nodes) state.open.add('srv:' + id);
  }
}
function mk(c, node, stack, external) {
  return {
    uid: `${node}/${stack || 'solo'}/${c.name}`, srv: node, stack, external, id: c.id, name: c.name, image: c.image,
    status: c.state, statusText: c.status, cpu: c.cpu, mem: c.mem, ports: c.ports || [], self: !!c.self, service: c.service,
  };
}
const nodeUp = id => !!state.nodeInfo.get(id)?.online;
// Mirrors server/roles.js. The server enforces it; the UI only hides what would be refused.
const RANK = { viewer: 0, operator: 1, admin: 2 };
const role = () => state.me?.role || 'viewer';
const can = min => RANK[role()] >= RANK[min];
const needs = min => `Needs the ${min} role; you are ${role()}`;
const isUp = c => nodeUp(c.srv);
const eff = c => (isUp(c) ? c.status : 'unknown');
const hostIndex = id => (Math.max(0, [...state.nodes].sort().indexOf(id)) % 6) + 1;
const hc = id => `var(--host-${hostIndex(id)})`;
const ht = id => `var(--host-${hostIndex(id)}-t)`;
const clusterNode = id => state.cluster?.nodes.find(n => n.id === id) || null;

function cur() {
  const s = state.sel;
  if (!s) return null;
  if (s.startsWith('stack:')) {
    const [srv, stack] = s.slice(6).split('/');
    const st = state.stacks.find(x => x.srv === srv && x.id === stack);
    return st ? { uid: s, isStack: true, srv, stack, external: st.external, name: stack, status: 'not deployed', ports: [], image: '' } : null;
  }
  const c = state.byUid.get(s);
  if (c) return c;
  const [srv, stack] = s.split('/');
  if (stack !== 'solo' && state.stacks.some(x => x.srv === srv && x.id === stack)) { state.sel = `stack:${srv}/${stack}`; return cur(); }
  return null;
}
const docKey = c => (c.stack ? `${c.srv}/${c.stack}` : `${c.srv}/ctr:${c.name}`);
const curDoc = () => { const c = cur(); return c ? docs.get(docKey(c)) : null; };

/* ---------- Top bar ---------- */
function renderTop() {
  const me = state.me?.node || '';
  $('viaBtn').innerHTML = `<span class="via-k">via</span><span class="swatch" style="--hc:${hc(me)}"></span>${esc(me)} ▾`;
  const vip = state.cluster?.vip;
  $('hostLine').innerHTML = `<b>${esc(location.host)}</b>${vip ? ` · floating IP ${esc(vip)}` : ''}`;
  const live = state.ctrs.filter(isUp), up = live.filter(c => c.status === 'running');
  const on = state.nodes.filter(nodeUp).length;
  const mem = up.reduce((a, c) => a + (c.mem || 0), 0);
  $('topStats').innerHTML = `<span><b>${on}</b>/${state.nodes.length} nodes up</span><span><b>${up.length}</b>/${live.length} running</span><span>RAM <b>${bytes(mem)}</b></span>`;
  $('clusterBtn').setAttribute('aria-pressed', state.view === 'cluster');
  $('whoami').textContent = state.me
    ? `Signed in as ${state.me.name ? `${state.me.name} (${state.me.user})` : state.me.user}, role ${role()}, with ${state.me.method === 'oidc' ? 'single sign-on' : state.me.method === 'break-glass' ? 'the break-glass password (session ends after 1 hour)' : 'the admin password'} · ${state.me.node} · SelfCluster ${state.me.version}`
    : '';
  const chip = $('roleChip');
  chip.hidden = !state.me || can('admin');
  chip.textContent = role();
  chip.title = role() === 'viewer' ? 'You can look at everything but not change anything' : 'You can start, stop and deploy, but not edit files or open a shell';
  $('newStackBtn').hidden = !can('admin');
}
function renderViaMenu() {
  const me = state.me.node;
  const nodes = state.cluster?.nodes || [];
  $('viaMenu').innerHTML = '<div class="menu-h">Connect through</div>' + nodes.map(n => {
    const ms = n.self ? 'current' : !n.online ? 'unreachable' : `${n.latency ?? '?'} ms`;
    return `<button class="menu-item" role="menuitemradio" aria-checked="${n.self}" data-via="${esc(n.id)}" ${n.online && !n.self ? '' : n.self ? '' : 'disabled'}><span class="swatch" style="--hc:${hc(n.id)}"></span><span class="grow">${esc(n.id)}<small>${esc(n.url)}</small></span><span class="ms">${ms}</span></button>`;
  }).join('') + `<div class="menu-foot">Every node serves this UI. You're on <code>${esc(me)}</code>; switching opens the same page on the other node and keeps you signed in.</div>`;
}
$('viaMenu').addEventListener('click', async e => {
  const b = e.target.closest('[data-via]');
  if (!b || b.disabled) return;
  closePops();
  if (b.dataset.via === state.me.node) return;
  handoff(b.dataset.via);
});
async function handoff(to) {
  try {
    const r = await api('/api/handoff', { method: 'POST', body: { to } });
    location.href = r.url;
  } catch (e) { toast(e.message); }
}

/* ---------- Sidebar ---------- */
const chevron = '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
function aggStatus(list, srv) {
  if (srv && !nodeUp(srv)) return { up: 0, total: list.length, cls: 'unknown' };
  const live = list.filter(isUp);
  if (!list.length) return { up: 0, total: 0, cls: 'exited' };
  if (!live.length) return { up: 0, total: list.length, cls: 'unknown' };
  const up = live.filter(c => c.status === 'running').length;
  return { up, total: list.length, cls: up === list.length ? 'running' : up === 0 ? 'exited' : 'partial' };
}
function matches(c) {
  const st = eff(c);
  if (state.filter === 'running' && st !== 'running') return false;
  if (state.filter === 'stopped' && st === 'running') return false;
  const q = state.q;
  return !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || (c.stack || '').includes(q) || c.srv.toLowerCase().includes(q);
}
const stackMatches = s => !state.q || s.id.includes(state.q) || s.srv.toLowerCase().includes(state.q);
const dot = cls => (opts.status === 'none' ? '' : `<span class="dot ${cls}"></span>`);
const htag = srv => `<span class="htag" style="--hc:${hc(srv)}">${esc(srv)}</span>`;
function ctrRow(c, depth, { tag = false, guide = true } = {}) {
  const st = eff(c);
  let meta = '';
  if (opts.status === 'meta') meta = `<span class="ctr-meta">${st === 'unknown' ? 'cached' : st === 'running' ? (c.cpu == null ? '' : c.cpu.toFixed(1) + '%') : esc(st)}</span>`;
  return `<button class="ctr${guide ? ' guide' : ''}${st === 'unknown' ? ' off' : ''}" style="--d:${depth}" data-uid="${esc(c.uid)}" aria-current="${state.sel === c.uid}">${dot(st)}<span class="ctr-name">${esc(c.name)}</span>${c.self ? '<span class="self-badge">this app</span>' : ''}${tag ? htag(c.srv) : ''}${meta}</button>`;
}
function openStackRow(s, depth, tag) {
  const uid = `stack:${s.srv}/${s.id}`;
  return `<button class="ctr guide open-stack${nodeUp(s.srv) ? '' : ' off'}" style="--d:${depth}" data-uid="${esc(uid)}" aria-current="${state.sel === uid}"><span class="ctr-name">not deployed · open files</span>${tag ? htag(s.srv) : ''}</button>`;
}
function dirtyStack(srv, stack) { const d = docs.get(`${srv}/${stack}`); return d && isDocDirty(d); }
function stackHead(key, label, depth, list, open, { srv, extra = '', dirty = false } = {}) {
  const st = aggStatus(list, srv);
  return `<button class="stack-head${st.cls === 'unknown' ? ' off' : ''}" style="--d:${depth}" data-toggle="${esc(key)}" aria-expanded="${open}">${chevron}${dot(st.cls)}<span class="stack-name">${esc(label)}${dirty ? ' <span class="dirty">●</span>' : ''}</span>${extra}<span class="count">${st.cls === 'unknown' ? '–' : st.up}/${st.total}</span></button>`;
}
const isOpen = k => state.open.has(k) || !!state.q;

function stackBlock(s, depth, tag = false) {
  const vis = s.containers.filter(matches);
  if (!vis.length && !(s.containers.length === 0 && stackMatches(s) && state.filter !== 'running')) return '';
  const k = `${s.srv}/${s.id}`, o = isOpen(k);
  let h = stackHead(k, s.id + (s.external ? ' (files missing)' : ''), depth, s.containers, o, { srv: s.srv, dirty: dirtyStack(s.srv, s.id) });
  if (o) h += s.containers.length ? vis.map(c => ctrRow(c, depth + 1, { tag })).join('') : openStackRow(s, depth + 1, tag);
  return h;
}

function renderTree() {
  if (!state.loaded) return;
  let h = '';
  const srvList = state.nodes.filter(id => (opts.tree === 'picker' ? id === state.pickSrv : state.srv === 'all' || id === state.srv));
  if (opts.tree === 'servers') {
    for (const id of srvList) {
      const ctrs = state.ctrs.filter(c => c.srv === id);
      const sts = state.stacks.filter(s => s.srv === id);
      if (state.q && !ctrs.some(matches) && !sts.some(stackMatches)) continue;
      const open = isOpen('srv:' + id), st = aggStatus(ctrs, id), up = nodeUp(id);
      const info = state.nodeInfo.get(id);
      const sub = up ? `${st.up}/${st.total}` : `offline · ${ago(info?.lastSeen || clusterNode(id)?.lastSeen)}`;
      h += `<div class="srv-head${up ? '' : ' off'}" style="--d:0"><button class="tw" data-toggle="srv:${esc(id)}" aria-expanded="${open}" aria-label="Expand ${esc(id)}">${chevron}</button><button class="srv-open" data-node="${esc(id)}" title="Open ${esc(id)} in the cluster page"><span class="swatch" style="--hc:${hc(id)}"></span><span class="stack-name">${esc(id)}</span><span class="srv-sub${up ? '' : ' bad'}">${sub}</span></button></div>`;
      if (!open) continue;
      for (const s of sts) h += stackBlock(s, 1);
      const solo = state.ctrs.filter(c => c.srv === id && !c.stack);
      const sv = solo.filter(matches);
      if (sv.length) {
        const k = `${id}/__solo`, o = isOpen(k);
        h += stackHead(k, 'standalone', 1, solo, o, { srv: id });
        if (o) h += sv.map(c => ctrRow(c, 2)).join('');
      }
      if (!sts.length && !solo.length) h += `<div class="empty" style="padding:6px 14px 6px 38px">${up ? 'No stacks or containers yet' : 'Nothing cached for this node'}</div>`;
    }
  } else if (opts.tree === 'picker') {
    const id = srvList[0];
    if (id) {
      if (!nodeUp(id)) h += `<div class="empty" style="padding:10px 14px">${esc(id)} is unreachable. Showing the copy cached on ${esc(state.me.node)}.</div>`;
      h += '<div class="group-label">Stacks</div>';
      for (const s of state.stacks.filter(x => x.srv === id)) h += `<div>${stackBlock(s, 0)}</div>`;
      const sv = state.ctrs.filter(c => c.srv === id && !c.stack && matches(c));
      if (sv.length) h += '<div class="group-label">Standalone</div>' + sv.map(c => ctrRow(c, 0, { guide: false })).join('');
    }
  } else {
    const inScope = s => srvList.includes(s.srv);
    const ids = [...new Set(state.stacks.filter(inScope).map(s => s.id))].sort();
    h += '<div class="group-label">Stacks across servers</div>';
    for (const id of ids) {
      const inst = state.stacks.filter(s => s.id === id && inScope(s));
      const list = inst.flatMap(s => s.containers), vis = list.filter(matches);
      const empties = inst.filter(s => !s.containers.length && stackMatches(s));
      if (!vis.length && !empties.length) continue;
      const k = 'stack:' + id, o = isOpen(k);
      const sw = `<span class="swatches">${inst.map(s => `<span class="swatch" style="--hc:${hc(s.srv)}" title="${esc(s.srv)}"></span>`).join('')}</span>`;
      h += stackHead(k, id, 0, list, o, { extra: sw, dirty: inst.some(s => dirtyStack(s.srv, s.id)) });
      if (o) {
        h += vis.sort((a, b) => a.name.localeCompare(b.name) || a.srv.localeCompare(b.srv)).map(c => ctrRow(c, 1, { tag: true })).join('');
        h += empties.map(s => openStackRow(s, 1, true)).join('');
      }
    }
    const sv = state.ctrs.filter(c => !c.stack && srvList.includes(c.srv) && matches(c)).sort((a, b) => a.name.localeCompare(b.name));
    if (sv.length) h += '<div class="group-label">Standalone</div>' + sv.map(c => ctrRow(c, 0, { tag: true, guide: false })).join('');
  }
  const tree = $('tree'), top = tree.scrollTop;
  tree.innerHTML = h || '<div class="empty">Nothing matches this filter.</div>';
  tree.scrollTop = top;
}
function renderSrvFilter() {
  const sel = $('srvFilter');
  const picker = opts.tree === 'picker';
  if (picker && !state.nodes.includes(state.pickSrv)) state.pickSrv = state.me?.node || state.nodes[0];
  if (!picker && state.srv !== 'all' && !state.nodes.includes(state.srv)) state.srv = 'all';
  sel.innerHTML = (picker ? '' : '<option value="all">All servers</option>') + state.nodes.map(id => `<option value="${esc(id)}">${esc(id)}${nodeUp(id) ? '' : ' (offline)'}</option>`).join('');
  sel.value = picker ? state.pickSrv : state.srv;
}
$('srvFilter').addEventListener('change', e => { if (opts.tree === 'picker') state.pickSrv = e.target.value; else state.srv = e.target.value; renderTree(); });
$('tree').addEventListener('click', e => {
  const t = e.target.closest('[data-toggle]');
  if (t) {
    const k = t.dataset.toggle;
    state.openTouched = true;
    if (state.open.has(k)) state.open.delete(k); else state.open.add(k);
    saveOpen(); renderTree(); return;
  }
  const n = e.target.closest('[data-node]');
  if (n) { showCluster(n.dataset.node); closeDrawer(); return; }
  const r = e.target.closest('.ctr');
  if (r) { select(r.dataset.uid); closeDrawer(); }
});
$('search').addEventListener('input', e => { state.q = e.target.value.trim().toLowerCase(); renderTree(); });
$('sideFilters').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.filter = b.dataset.f;
  [...$('sideFilters').children].forEach(x => x.setAttribute('aria-pressed', x === b));
  renderTree();
});
$('expandAll').onclick = () => {
  state.openTouched = true;
  for (const id of state.nodes) { state.open.add('srv:' + id); state.open.add(id + '/__solo'); }
  for (const s of state.stacks) { state.open.add(`${s.srv}/${s.id}`); state.open.add('stack:' + s.id); }
  saveOpen(); renderTree();
};
$('collapseAll').onclick = () => { state.openTouched = true; state.open.clear(); saveOpen(); renderTree(); };
const closeDrawer = () => $('app').classList.remove('side-open');
$('menuBtn').onclick = () => $('app').classList.add('side-open');
$('scrim').onclick = closeDrawer;

/* ---------- Header ---------- */
function renderHead() {
  const c = cur();
  if (!c) return;
  const up = isUp(c);
  const twins = c.isStack ? [] : state.ctrs.filter(x => x.name === c.name);
  const hostPart = twins.length > 1
    ? `<span class="swatch" style="--hc:${hc(c.srv)}"></span><select class="hostjump" id="hostJump" aria-label="Same container on another server">${twins.map(x => `<option value="${esc(x.uid)}" ${x.uid === c.uid ? 'selected' : ''}>${esc(x.srv)}${isUp(x) ? '' : ' (offline)'}</option>`).join('')}</select>`
    : `<span class="swatch" style="--hc:${hc(c.srv)}"></span>${esc(c.srv)}`;
  $('crumbs').innerHTML = `${hostPart}<span>/</span><span>${c.stack ? 'stacks / ' + esc(c.stack) : 'standalone'}</span>`;
  $('hostJump')?.addEventListener('change', e => select(e.target.value));
  $('ctitle').textContent = c.name;
  const p = $('cstatus');
  if (!up) { p.className = 'pill unknown'; p.textContent = c.isStack ? 'unknown · node offline' : `unknown · last seen ${c.status}`; }
  else if (c.isStack) { p.className = 'pill exited'; p.textContent = 'not deployed'; }
  else { p.className = 'pill ' + (['running', 'exited', 'restarting'].includes(c.status) ? c.status : 'unknown'); p.textContent = c.status; }

  $('ctrActions').hidden = !!c.isStack;
  if (!c.isStack) {
    $('startStop').textContent = c.status === 'running' || c.status === 'restarting' ? 'Stop' : 'Start';
    const op = can('operator'), adm = can('admin');
    $('startStop').disabled = !up || !op || (c.self && c.status === 'running');
    $('restartBtn').disabled = !up || !op;
    $('pullBtn').disabled = !up || !op;
    $('removeBtn').disabled = !up || !adm || c.self;
    $('startStop').title = !op ? needs('operator') : c.self ? 'SelfCluster cannot stop itself' : '';
    $('restartBtn').title = $('pullBtn').title = op ? '' : needs('operator');
    $('removeBtn').title = adm ? '' : needs('admin');
  }
  const node = clusterNode(c.srv);
  const relay = c.srv === state.me.node ? 'local' : up ? `relayed via ${state.me.node} · ${node?.latency ?? '?'} ms` : 'no route';
  const facts = [];
  if (!c.isStack) {
    facts.push(`<span>Image <code>${esc(c.image)}</code></span>`);
    facts.push(`<span>Ports <code>${c.ports.length ? esc(c.ports.join(', ')) : 'none'}</code></span>`);
    facts.push(`<span>Status <code>${up ? esc(c.statusText) : '?'}</code></span>`);
    facts.push(`<span>ID <code>${esc(c.id.slice(0, 12))}</code></span>`);
  }
  facts.push(`<span>Node <code>${esc(node?.url || c.srv)}</code></span>`);
  facts.push(`<span>Connection <code>${relay}</code></span>`);
  $('facts').innerHTML = facts.join('');
  const b = $('offBanner');
  b.hidden = up;
  if (!up) {
    const info = state.nodeInfo.get(c.srv);
    const since = info?.lastSeen || node?.lastSeen;
    b.innerHTML = `<span><b>${esc(c.srv)} is unreachable</b>${since ? ` since ${hhmm(since)} (${ago(since)})` : ''}. You're looking at the copy cached on ${esc(state.me.node)}${info?.cachedAt ? ` from ${ago(info.cachedAt)}` : ''}. Editing and actions are off.</span>${c.stack && !c.external && can('admin') ? '<button class="btn" id="deployElsewhere">Deploy on another server…</button>' : ''}`;
    $('deployElsewhere')?.addEventListener('click', e => { e.stopPropagation(); openDeployMenu(e.currentTarget); });
  }
  $('tab-inspect').disabled = !!c.isStack;
}

async function containerAct(act) {
  const c = cur();
  if (!c || c.isStack) return;
  if (act === 'toggle') act = c.status === 'running' || c.status === 'restarting' ? 'stop' : 'start';
  if (act === 'remove') {
    const ok = await ask(`Remove ${c.name}?`, `<p>This force-removes the container <b>${esc(c.name)}</b> on ${esc(c.srv)}. Named volumes stay.${c.stack ? ` Deploying the <b>${esc(c.stack)}</b> stack again recreates it.` : ' It was not started by compose, so SelfCluster cannot recreate it.'}</p>`, 'Remove container');
    if (!ok) return;
  }
  const label = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', pull: 'Pulling the image for', remove: 'Removing' }[act];
  toast(`${label} ${c.name} on ${c.srv}…`, 60e3);
  try {
    await api(N(c.srv, `/containers/${c.id}/${act}`), { method: 'POST' });
    toast(act === 'pull' ? `Pulled ${c.image} on ${c.srv}. Deploy the stack to use the new image.` : `${c.name}: ${act} done`);
  } catch (e) { toast(e.message); }
  refreshOverview();
}
$('startStop').onclick = () => containerAct('toggle');
$('restartBtn').onclick = () => containerAct('restart');
$('pullBtn').onclick = () => containerAct('pull');
$('removeBtn').onclick = () => containerAct('remove');

/* ---------- Deploy elsewhere (from cache) ---------- */
function openDeployMenu(btn) {
  const c = cur(), m = $('ctxMenu');
  const targets = state.nodes.filter(id => id !== c.srv);
  m.innerHTML = `<div class="menu-h">Deploy stack "${esc(c.stack)}" on</div>` + targets.map(id => {
    const n = clusterNode(id);
    return `<button class="menu-item" data-target="${esc(id)}" ${nodeUp(id) ? '' : 'disabled'}><span class="swatch" style="--hc:${hc(id)}"></span><span class="grow">${esc(id)}<small>${esc(n?.host?.os || n?.url || '')}</small></span><span class="ms">${nodeUp(id) ? 'online' : 'offline'}</span></button>`;
  }).join('') + `<div class="menu-foot">Uses the compose and env files cached on ${esc(state.me.node)}. Volumes and bind-mounted data are not copied.</div>`;
  openPop(m, btn);
}
$('ctxMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-target]');
  if (!b || b.disabled) return;
  closePops();
  deployElsewhere(b.dataset.target);
});
async function deployElsewhere(target) {
  const c = cur(), d = curDoc();
  if (!d || !d.compose?.content) { toast('There are no cached files for this stack'); return; }
  const files = [{ name: d.compose.name, content: d.compose.content }, ...d.env.map(f => ({ name: f.base || f.name, content: f.content }))].filter((f, i, all) => all.findIndex(x => x.name === f.name) === i);
  let name = c.stack;
  toast(`Creating ${name} on ${target} and running docker compose up…`, 15 * 60e3);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await api(N(target, '/stacks'), { method: 'POST', body: { name, files, up: true } });
      toast(`Deployed ${name} on ${target} from the cached files`);
      await refreshOverview();
      select(`stack:${target}/${name}`);
      const ctr = state.ctrs.find(x => x.srv === target && x.stack === name && x.name === c.name);
      if (ctr) select(ctr.uid);
      if (r.output) console.info(r.output);
      return;
    } catch (e) {
      if (e.status === 409 && attempt === 0) { name = `${c.stack}-restored`; continue; }
      showOutput(`Deploy on ${target} failed`, e.data?.output || e.message);
      refreshOverview();
      return;
    }
  }
}

/* ---------- Tabs & views ---------- */
function setTab(t) {
  const c = cur();
  if (t === 'inspect' && c?.isStack) t = 'compose';
  state.tab = t;
  $('tab-compose').setAttribute('aria-selected', t === 'compose');
  $('tab-inspect').setAttribute('aria-selected', t === 'inspect');
  renderView();
}
function renderView() {
  const se = state.view === 'settings';
  const cl = state.view === 'cluster' || se, c = cur();
  $('mainEmpty').hidden = cl || !!c;
  $('mainHead').hidden = cl || !c;
  $('view-cluster').hidden = state.view !== 'cluster';
  $('view-settings').hidden = !se;
  $('view-compose').hidden = cl || !c || state.tab !== 'compose';
  $('view-inspect').hidden = cl || !c || state.tab !== 'inspect';
  $('clusterBtn').setAttribute('aria-pressed', cl);
  syncStreams();
  if (!$('view-inspect').hidden) requestAnimationFrame(fitTerm);
}
$('tab-compose').onclick = () => setTab('compose');
$('tab-inspect').onclick = () => setTab('inspect');
$('clusterBtn').onclick = () => { if (state.view === 'cluster') { state.view = 'container'; renderView(); } else showCluster(null); };

/* ---------- Editors ---------- */
function gutter(ta, g) {
  const n = ta.value.split('\n').length;
  if (g._n !== n) { g.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); g._n = n; }
  g.style.transform = `translateY(${-ta.scrollTop}px)`;
}
function tabKey(e) {
  if (e.key !== 'Tab' || e.target.readOnly || e.shiftKey) return;
  e.preventDefault();
  e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
  e.target.dispatchEvent(new Event('input'));
}
const ct = $('composeText'), et = $('envText');
ct.addEventListener('keydown', tabKey);
et.addEventListener('keydown', tabKey);
ct.addEventListener('scroll', () => gutter(ct, $('composeGutter')));
et.addEventListener('scroll', () => gutter(et, $('envGutter')));
ct.addEventListener('input', () => { const d = curDoc(); if (d) d.composeEdit = ct.value; gutter(ct, $('composeGutter')); renderDirty(); });
et.addEventListener('input', () => {
  const d = curDoc();
  if (!d) return;
  if (d.envActive === '__shared') shared.edit = et.value;
  else { const f = d.env.find(x => x.name === d.envActive); if (f) f.edit = et.value; }
  gutter(et, $('envGutter')); renderDirty(); renderEnvTabs();
});

function isDocDirty(d) {
  return d.composeEdit !== d.compose.content || d.env.some(f => f.isNew || f.edit !== f.content);
}
function fromFiles(key, c, f, prev) {
  // Files are keyed by their path relative to the project folder (two folders can both have a .env).
  const env = f.env.map(e => ({ ...e, base: e.name, name: e.label || e.name, edit: e.content }));
  const keep = prev?.envActive && (prev.envActive === '__shared' || env.some(e => e.name === prev.envActive));
  return {
    key, node: c.srv, stack: c.stack, dir: f.dir, readOnly: !!f.readOnly, cachedAt: f.cachedAt || null, masked: !!f.masked,
    compose: f.compose, composeEdit: f.compose.content, env,
    envActive: keep ? prev.envActive : (env[0]?.name || '__shared'), conflict: null, envConflict: null,
  };
}
async function loadDocFor(c, force = false) {
  const key = docKey(c);
  const prev = docs.get(key);
  if (prev && (isDocDirty(prev) || prev.conflict || prev.envConflict) && !force) { renderEditors(); return; }
  let d;
  try {
    if (c.stack && !c.external) {
      d = fromFiles(key, c, await api(N(c.srv, `/stacks/${enc(c.stack)}/files`)), prev);
    } else if (c.external) {
      d = { key, node: c.srv, stack: c.stack, readOnly: true, note: `SelfCluster can't read the files for ${c.stack} on ${c.srv}${state.stacks.find(x => x.srv === c.srv && x.id === c.stack)?.dir ? ` (${state.stacks.find(x => x.srv === c.srv && x.id === c.stack).dir})` : ''}. They may have been moved or deleted, or the project was started without labels that say where they are. Containers can still be started, stopped and inspected.`, compose: { name: 'compose.yaml', content: '', etag: null }, composeEdit: '', env: [], envActive: '__shared' };
    } else {
      const r = await api(N(c.srv, `/containers/${c.id}/readback`));
      d = { key, node: c.srv, stack: null, readOnly: true, readback: true, note: 'Started without compose. This is a read-back from docker inspect: copy it into a new stack to manage the container here.', compose: { name: 'docker inspect', content: r.content, etag: null }, composeEdit: r.content, env: [], envActive: '__shared' };
    }
  } catch (e) {
    d = { key, node: c.srv, stack: c.stack, readOnly: true, error: true, note: e.message, compose: { name: '', content: '', etag: null }, composeEdit: '', env: [], envActive: '__shared' };
  }
  docs.set(key, d);
  const now = cur();
  if (now && docKey(now) === key) renderEditors(prev?.key !== key || !prev);
}

function renderEditors(scrollToService = false) {
  const c = cur(), d = curDoc();
  if (!c || !d) return;
  const editable = !d.readOnly && isUp(c) && can('admin');
  $('composePath').textContent = d.readback ? `${c.srv}: docker inspect ${c.name}` : d.compose.path ? `${c.srv}:${d.compose.path}` : d.dir ? `${c.srv}:${d.dir}/${d.compose.name}` : `${c.srv}: ${c.stack || c.name}`;
  ct.readOnly = !editable;
  $('composeRo').hidden = editable;
  $('composeRo').textContent = d.cachedAt ? `cached ${ago(d.cachedAt)}` : !can('admin') && !d.readOnly ? `read-only for ${role()}` : 'read-only';
  const note = $('composeNote');
  note.hidden = !d.note;
  note.className = 'banner conflict' + (d.error ? ' err' : '');
  note.textContent = d.note || '';
  if (c.isStack && can('admin') && isUp(c)) {
    note.hidden = false;
    note.innerHTML = `<span>${esc(d.note || `${c.stack} has no containers right now. Deploy it, or forget it if it's gone for good.`)}</span><button class="btn" id="forgetStack">Forget stack</button>`;
    $('forgetStack').onclick = () => forgetStack(c);
  }
  if (ct.value !== d.composeEdit) { ct.value = d.composeEdit; ct.scrollTop = 0; }
  gutter(ct, $('composeGutter'));
  if (scrollToService && c.service && d.composeEdit) {
    const idx = d.composeEdit.search(new RegExp(`\\n  ${c.service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*\\n`));
    if (idx > -1) {
      const line = d.composeEdit.slice(0, idx + 1).split('\n').length - 1;
      requestAnimationFrame(() => { const lh = parseFloat(getComputedStyle(ct).lineHeight) || 20; ct.scrollTop = Math.max(0, (line - 2) * lh); gutter(ct, $('composeGutter')); });
    }
  }
  const cf = $('conflict');
  cf.hidden = !d.conflict;
  if (d.conflict) {
    const m = d.conflict.current?.modified;
    cf.innerHTML = d.conflict.current
      ? `<span><b>${esc(d.compose.name)} changed on ${esc(c.srv)} after you opened it.</b> ${m ? `${esc(m.by)} saved it via ${esc(m.via)} ${ago(m.at)}.` : ''} Your save was not applied.</span><button class="btn" id="cfCompare">Compare</button>`
      : `<span><b>${esc(d.compose.name)} was deleted on ${esc(c.srv)}.</b></span>`;
    $('cfCompare')?.addEventListener('click', () => openDiff('compose'));
  }
  renderEnvTabs(); loadEnv(); renderDirty();
}
function envDirty(d, name) {
  if (name === '__shared') return shared.edit !== null && shared.edit !== shared.value;
  const f = d.env.find(x => x.name === name);
  return !!f && (f.isNew || f.edit !== f.content);
}
function renderEnvTabs() {
  const d = curDoc();
  if (!d) return;
  const sharedTab = `<button class="envtab" role="tab" data-env="__shared" aria-selected="${d.envActive === '__shared'}">${envDirty(d, '__shared') ? '<span class="mod"></span>' : ''}shared.env <span class="scope">cluster</span></button>`;
  $('envTabs').innerHTML = sharedTab + d.env.map(f => `<button class="envtab" role="tab" data-env="${esc(f.name)}" aria-selected="${f.name === d.envActive}">${envDirty(d, f.name) ? '<span class="mod"></span>' : ''}${esc(f.name)}${f.kind === 'compose' ? ' <span class="scope">compose</span>' : ''}</button>`).join('');
}
function loadEnv() {
  const d = curDoc(), c = cur();
  if (!d || !c) return;
  const isShared = d.envActive === '__shared';
  const f = isShared ? null : d.env.find(x => x.name === d.envActive);
  const val = isShared ? (shared.edit ?? shared.value) : (f?.edit ?? '');
  if (et.value !== val) { et.value = val; et.scrollTop = 0; }
  et.readOnly = !can('admin') || (isShared ? false : (d.readOnly || !isUp(c)));
  const note = $('envNote');
  note.hidden = !isShared && !(d.masked && d.env.length);
  if (!isShared) note.textContent = 'Values are hidden: only admins can see and edit env files.';
  if (isShared) {
    const nodes = state.cluster?.nodes || [];
    const behind = nodes.filter(n => !n.self && n.digest && n.digest !== state.cluster.digest).map(n => n.id);
    note.textContent = `Shared by every node (v${shared.v}${shared.by ? `, last saved by ${shared.by} ${ago(shared.ts)}` : ''}). Written to ${state.me.stacksDir}/shared.env on each node; reference it from any stack with env_file: ${state.me.stacksDir}/shared.env.${behind.length ? ` ${behind.join(', ')} ${behind.length > 1 ? 'have' : 'has'} not synced yet.` : ''}`;
  }
  const ec = $('envConflict');
  const conflict = isShared ? shared.conflict : (d.envConflict?.file === d.envActive ? d.envConflict : null);
  ec.hidden = !conflict;
  if (conflict) {
    const by = isShared ? conflict.by : conflict.current?.modified?.by;
    ec.innerHTML = `<span><b>${esc(isShared ? 'shared.env' : d.envActive)} changed after you opened it${by ? ` (saved by ${esc(by)})` : ''}.</b> Your save was not applied.</span><button class="btn" id="ecCompare">Compare</button>`;
    $('ecCompare').addEventListener('click', () => openDiff(isShared ? 'shared' : 'env'));
  }
  gutter(et, $('envGutter'));
}
$('envTabs').addEventListener('click', e => {
  const b = e.target.closest('.envtab');
  const d = curDoc();
  if (!b || !d) return;
  d.envActive = b.dataset.env;
  renderEnvTabs(); loadEnv(); renderDirty();
});
$('addEnv').onclick = async () => {
  const d = curDoc();
  if (!d || d.readOnly || !d.stack) return;
  const name = await ask('New env file', '<label class="field">File name<input id="askInput" value="app.env" autocomplete="off"></label><p>Use .env or a name ending in .env. The file is created when you save it.</p>', 'Add file', () => $('askInput').value.trim());
  if (!name) return;
  if (!/^(?:\.env|[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}\.env)$/.test(name)) { toast('Env file names must be .env or end in .env'); return; }
  if (d.env.some(f => f.name === name)) { toast(`${name} already exists`); return; }
  d.env.push({ name, content: '', edit: '# KEY=value\n', etag: null, isNew: true });
  d.envActive = name;
  renderEnvTabs(); loadEnv(); renderDirty(); et.focus();
};
function renderDirty() {
  const c = cur(), d = curDoc();
  if (!c || !d) return;
  const own = state.stacks.find(s => s.srv === c.srv && s.id === c.stack)?.self;
  const live = !d.readOnly && isUp(c) && !!c.stack && !c.external && !own;
  const deployable = live && can('operator');
  const editable = live && can('admin');
  const cd = d.composeEdit !== d.compose.content;
  $('composeDirty').hidden = !cd;
  $('deployBtn').textContent = cd ? 'Save & deploy' : 'Deploy';
  $('deployBtn').disabled = !deployable || busy;
  $('revertBtn').disabled = !cd;
  $('validateBtn').disabled = !deployable;
  $('stackDownBtn').disabled = !deployable || busy || c.isStack;
  for (const id of ['deployBtn', 'validateBtn', 'stackDownBtn']) $(id).title = own ? "SelfCluster's own stack: update it with docker compose on the host" : live && !can('operator') ? needs('operator') : '';
  const sharedActive = d.envActive === '__shared';
  $('saveEnv').disabled = !can('admin') || !envDirty(d, d.envActive) || (!sharedActive && !editable) || busy;
  $('addEnv').disabled = !editable;
  $('addEnv').title = live && !can('admin') ? needs('admin') : '';
  clearTimeout(renderDirty.t);
  renderDirty.t = setTimeout(renderTree, 200);
}
$('revertBtn').onclick = () => {
  const d = curDoc();
  if (!d) return;
  d.composeEdit = d.compose.content; d.conflict = null;
  renderEditors(); toast('Reverted to the saved version');
};

let busy = false;
function setBusy(b) { busy = b; document.body.classList.toggle('busy', b); renderDirty(); }

async function saveCompose(d, etag) {
  try {
    d.compose = await api(N(d.node, `/stacks/${enc(d.stack)}/files/${enc(d.compose.id || d.compose.name)}`), { method: 'PUT', body: { content: d.composeEdit, etag } });
    d.composeEdit = d.compose.content; d.conflict = null;
    return true;
  } catch (e) {
    if (e.status === 409) { d.conflict = e.data; renderEditors(); return false; }
    throw e;
  }
}
$('deployBtn').onclick = async () => {
  const c = cur(), d = curDoc();
  if (!d || d.readOnly || busy) return;
  setBusy(true);
  try {
    if (d.composeEdit !== d.compose.content && !(await saveCompose(d, d.compose.etag))) return;
    renderEditors();
    toast(`Running docker compose up -d for ${d.stack} on ${d.node}…`, 15 * 60e3);
    await api(N(d.node, `/stacks/${enc(d.stack)}/up`), { method: 'POST' });
    toast(`Deployed ${d.stack} on ${d.node}`);
  } catch (e) {
    toast('');
    showOutput(`Deploy of ${d.stack} on ${c.srv} failed`, e.data?.output || e.message);
  } finally { setBusy(false); refreshOverview(); }
};
$('stackDownBtn').onclick = async () => {
  const d = curDoc();
  if (!d || d.readOnly) return;
  const ok = await ask(`Stop ${d.stack}?`, `<p>Runs <code>docker compose down</code> for <b>${esc(d.stack)}</b> on ${esc(d.node)}. Containers and the stack's default network are removed. Volumes and files stay, and Deploy brings it back.</p>`, 'Stop stack');
  if (!ok) return;
  setBusy(true);
  toast(`Running docker compose down for ${d.stack}…`, 5 * 60e3);
  try { await api(N(d.node, `/stacks/${enc(d.stack)}/down`), { method: 'POST' }); toast(`${d.stack} is down`); }
  catch (e) { toast(''); showOutput(`docker compose down failed`, e.data?.output || e.message); }
  finally { setBusy(false); refreshOverview(); }
};
$('validateBtn').onclick = async () => {
  const d = curDoc();
  if (!d) return;
  try { await api(N(d.node, `/stacks/${enc(d.stack)}/validate`), { method: 'POST', body: { content: ct.value } }); toast(`${d.compose.name} is valid`); }
  catch (e) { toast(e.message, 8000); }
};
$('saveEnv').onclick = async () => {
  const d = curDoc();
  if (!d || busy) return;
  if (d.envActive === '__shared') {
    try {
      const r = await api('/api/cluster/shared-env', { method: 'PUT', body: { content: shared.edit, v: shared.v } });
      shared = { ...shared, value: r.value, v: r.v, by: r.by, ts: r.ts, edit: null, conflict: null };
      toast(`Saved shared.env v${r.v}. Other nodes get it within seconds; redeploy stacks to apply it.`, 5000);
    } catch (e) {
      if (e.status === 409) shared.conflict = e.data.current; else toast(e.message);
    }
  } else {
    const f = d.env.find(x => x.name === d.envActive);
    try {
      const r = await api(N(d.node, `/stacks/${enc(d.stack)}/files/${enc(f.id || f.name)}`), { method: 'PUT', body: { content: f.edit, etag: f.isNew ? null : f.etag } });
      Object.assign(f, r, { base: r.name, name: r.label || r.name, edit: r.content, isNew: false });
      d.envConflict = null;
      toast(`Saved ${f.name} on ${d.node}. Deploy the stack to apply it.`);
    } catch (e) {
      if (e.status === 409) d.envConflict = { file: f.name, current: e.data.current }; else toast(e.message);
    }
  }
  renderEnvTabs(); loadEnv(); renderDirty();
};

async function forgetStack(c) {
  const ok = await ask(`Forget ${c.stack}?`, `<p>SelfCluster stops listing <b>${esc(c.stack)}</b> on ${esc(c.srv)}. No files are deleted. It comes back if its containers run again, or if its folder is in ${esc(state.me.stacksDir)}.</p>`, 'Forget stack');
  if (!ok) return;
  try {
    await api(N(c.srv, `/stacks/${enc(c.stack)}/forget`), { method: 'POST' });
    docs.delete(docKey(c));
    toast(`Forgot ${c.stack}`);
    state.sel = null;
    await refreshOverview();
  } catch (e) { toast(e.message); }
}

/* ---------- Diff ---------- */
function lineDiff(a, b) {
  a = a.split('\n'); b = b.split('\n');
  if (a.length * b.length > 4e6) return [...a.map(l => ['-', l]), ...b.map(l => ['+', l])];
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}
let diffCtx = null;
function openDiff(kind) {
  const d = curDoc(), c = cur();
  let theirs, mine, label;
  if (kind === 'compose') { theirs = d.conflict.current.content; mine = d.composeEdit; label = `${c.srv}:${d.compose.path || `${d.dir}/${d.compose.name}`}`; }
  else if (kind === 'env') { const f = d.env.find(x => x.name === d.envConflict.file); theirs = d.envConflict.current?.content ?? ''; mine = f.edit; label = `${c.srv}:${d.dir}/${f.name}`; }
  else { theirs = shared.conflict.value; mine = shared.edit; label = 'shared.env (cluster)'; }
  diffCtx = kind;
  const rows = lineDiff(theirs, mine);
  const keep = rows.map((r, i) => r[0] !== ' ' || rows.slice(Math.max(0, i - 3), i + 4).some(x => x[0] !== ' '));
  let h = '', skip = 0;
  rows.forEach((r, i) => {
    if (!keep[i]) { skip++; return; }
    if (skip) { h += `<div class="dl fold">${skip} unchanged lines</div>`; skip = 0; }
    h += `<div class="dl ${r[0] === '+' ? 'add' : r[0] === '-' ? 'del' : 'same'}"><i>${r[0] === '+' ? '+' : r[0] === '-' ? '−' : ''}</i>${esc(r[1]) || ' '}</div>`;
  });
  if (skip) h += `<div class="dl fold">${skip} unchanged lines</div>`;
  $('diffBody').innerHTML = h || '<div class="empty">The two versions are identical.</div>';
  $('diffPath').textContent = label;
  $('diffModal').hidden = false;
  $('diffClose').focus();
}
$('diffClose').onclick = () => { $('diffModal').hidden = true; };
$('diffMine').onclick = async () => {
  $('diffModal').hidden = true;
  const d = curDoc();
  try {
    if (diffCtx === 'compose') { if (await saveCompose(d, d.conflict.current.etag)) toast('Saved your version. Click Deploy to apply it.'); }
    else if (diffCtx === 'env') {
      const f = d.env.find(x => x.name === d.envConflict.file);
      const r = await api(N(d.node, `/stacks/${enc(d.stack)}/files/${enc(f.id || f.name)}`), { method: 'PUT', body: { content: f.edit, etag: d.envConflict.current?.etag || null } });
      Object.assign(f, r, { base: r.name, name: r.label || r.name, edit: r.content, isNew: false }); d.envConflict = null; toast(`Saved your version of ${f.name}`);
    } else {
      const r = await api('/api/cluster/shared-env', { method: 'PUT', body: { content: shared.edit, v: shared.conflict.v } });
      shared = { ...shared, value: r.value, v: r.v, by: r.by, ts: r.ts, edit: null, conflict: null }; toast(`Saved your version of shared.env (v${r.v})`);
    }
  } catch (e) {
    if (e.status === 409) toast('It changed again in the meantime. Compare once more.');
    else toast(e.message);
  }
  renderEditors();
};
$('diffTheirs').onclick = () => {
  $('diffModal').hidden = true;
  const d = curDoc();
  if (diffCtx === 'compose') { d.compose = d.conflict.current; d.composeEdit = d.compose.content; d.conflict = null; }
  else if (diffCtx === 'env') { const f = d.env.find(x => x.name === d.envConflict.file); Object.assign(f, d.envConflict.current, { base: d.envConflict.current.name, name: d.envConflict.current.label || d.envConflict.current.name, edit: d.envConflict.current.content, isNew: false }); d.envConflict = null; }
  else { shared = { ...shared, value: shared.conflict.value, v: shared.conflict.v, by: shared.conflict.by, ts: shared.conflict.ts, edit: null, conflict: null }; }
  renderEditors();
  toast('Loaded the version on the server. Your edits were discarded.');
};

/* ---------- Splitters ---------- */
document.querySelectorAll('.handle').forEach(h => {
  h.addEventListener('pointerdown', e => {
    const box = $(h.dataset.split), a = box.querySelector('.pane-a');
    const row = getComputedStyle(box).flexDirection === 'row';
    const r = box.getBoundingClientRect();
    h.setPointerCapture(e.pointerId); h.classList.add('drag');
    const move = ev => {
      const pos = row ? ev.clientX - r.left : ev.clientY - r.top, size = row ? r.width : r.height;
      a.style.flexBasis = Math.min(Math.max(pos, 90), size - 100) + 'px';
      gutter(ct, $('composeGutter'));
    };
    const up = () => { h.classList.remove('drag'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); fitTerm(); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
  h.addEventListener('dblclick', () => { $(h.dataset.split).querySelector('.pane-a').style.flexBasis = ''; fitTerm(); });
});

/* ---------- Inspection: stats, terminal, logs ---------- */
let streamKey = null;
function syncStreams() {
  const c = cur();
  const visible = state.view === 'container' && state.tab === 'inspect' && c && !c.isStack;
  const key = visible ? `${c.uid}|${c.id}|${isUp(c)}|${c.status === 'running'}` : null;
  if (key === streamKey) return;
  streamKey = key;
  closeLogs(); closeTerm(); stopStats();
  if (!visible) return;
  renderTermMeta();
  connectLogs(c);
  connectTerm(c);
  startStats(c);
}

let statsTimer = null, statsHist = { cpu: [], mem: [], last: null };
function stopStats() { clearInterval(statsTimer); statsTimer = null; }
function startStats(c) {
  statsHist = { cpu: [], mem: [], last: null, uid: c.uid };
  renderStats(c, null);
  if (!isUp(c)) return;
  const tick = async () => {
    try {
      const s = await api(N(c.srv, `/containers/${c.id}/stats`));
      if (cur()?.uid !== c.uid) return;
      const prev = statsHist.last;
      const dt = prev ? (s.at - prev.at) / 1000 : 0;
      s.rxRate = prev && dt > 0 ? Math.max(0, (s.rx - prev.rx) / dt) : null;
      s.txRate = prev && dt > 0 ? Math.max(0, (s.tx - prev.tx) / dt) : null;
      statsHist.last = s;
      statsHist.cpu.push(s.cpu); statsHist.mem.push(s.mem);
      if (statsHist.cpu.length > 40) { statsHist.cpu.shift(); statsHist.mem.shift(); }
      renderStats(c, s);
    } catch { /* node may have gone */ }
  };
  tick();
  statsTimer = setInterval(tick, 3000);
}
function spark(arr, color) {
  if (arr.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
  const max = Math.max(...arr, 1e-9), w = 120, h = 22;
  const pts = arr.map((v, i) => `${(i / (arr.length - 1) * w).toFixed(1)},${(h - 2 - v / max * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${h} ${pts} ${w},${h}" fill="${color}" opacity=".14"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
}
function renderStats(c, s) {
  const el = $('stats');
  el.hidden = opts.stats === 'hide';
  if (!isUp(c)) {
    el.innerHTML = ['CPU', 'Memory', 'Network I/O', 'Restarts · PIDs'].map(k => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">—<small>no data</small></div><div class="stat-k" style="margin-top:6px">${esc(c.srv)} unreachable</div></div>`).join('');
    return;
  }
  const v = (x, f) => (s ? f(x) : '…');
  el.innerHTML = `
    <div class="stat"><div class="stat-k">CPU</div><div class="stat-v">${v(s?.cpu, x => x.toFixed(1))}<small>%</small></div>${spark(statsHist.cpu, 'var(--accent)')}</div>
    <div class="stat"><div class="stat-k">Memory</div><div class="stat-v">${v(s?.mem, bytes)}${s?.memLimit ? `<small>of ${bytes(s.memLimit)}</small>` : ''}</div>${spark(statsHist.mem, 'var(--info)')}</div>
    <div class="stat"><div class="stat-k">Network I/O</div><div class="stat-v">${s?.rxRate != null ? bytes(s.rxRate) : '…'}<small>/s ↓</small></div><div class="stat-k" style="margin-top:6px">${s?.txRate != null ? bytes(s.txRate) : '…'}/s ↑</div></div>
    <div class="stat"><div class="stat-k">Restarts · PIDs</div><div class="stat-v">${v(s?.restarts, x => x)}<small>restarts</small> ${v(s?.pids, x => x ?? '—')}<small>pids</small></div><div class="stat-k" style="margin-top:6px">health: ${esc(s?.health || 'no check')}</div></div>`;
}

// Terminal (xterm.js)
let term = null, fit = null, termWs = null;
function ensureTerm() {
  if (term) return;
  term = new window.Terminal({
    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 12.5, cursorBlink: true, scrollback: 5000,
    theme: { background: '#0d1316', foreground: '#cfe0e4', cursor: '#5fd3df', selectionBackground: '#2a4a52' },
  });
  const Fit = window.FitAddon?.FitAddon || window.FitAddon;
  fit = new Fit();
  term.loadAddon(fit);
  term.open($('term'));
  term.onData(d => { if (termWs?.readyState === 1) termWs.send(JSON.stringify({ t: 'i', d })); });
  term.onResize(({ cols, rows }) => { if (termWs?.readyState === 1) termWs.send(JSON.stringify({ t: 'r', c: cols, r: rows })); });
  new ResizeObserver(() => fitTerm()).observe($('term'));
}
function fitTerm() { try { if (term && !$('view-inspect').hidden) fit.fit(); } catch { /* not visible */ } }
function renderTermMeta() {
  const c = cur();
  if (!c) return;
  $('termPanel').style.setProperty('--ht', ht(c.srv));
  $('termHost').innerHTML = htag(c.srv);
  $('termPath').textContent = `docker exec -it ${c.name} ${$('shellSel').value === 'auto' ? 'bash || sh' : $('shellSel').value}${c.srv === state.me.node ? '' : ` · via ${state.me.node}`}`;
}
function closeTerm() { if (termWs) { termWs.onclose = null; termWs.close(); termWs = null; } }
function connectTerm(c) {
  ensureTerm();
  closeTerm();
  term.reset();
  fitTerm();
  const dim = s => `\x1b[38;5;245m${s}\x1b[0m`, red = s => `\x1b[38;5;210m${s}\x1b[0m`;
  if (!can('admin')) { term.writeln(dim(`A shell in the container is root on it, so it needs the admin role. You are ${role()}.`)); return; }
  if (!isUp(c)) { term.writeln(red(`${c.srv} is unreachable, so no shell can be opened.`)); return; }
  if (c.status !== 'running') { term.writeln(red(`${c.name} is not running.`) + dim(' Start it to open a shell.')); return; }
  const q = new URLSearchParams({ shell: $('shellSel').value, cols: term.cols, rows: term.rows });
  const ws = new WebSocket(wsUrl(N(c.srv, `/ws/exec/${c.id}?${q}`)));
  termWs = ws;
  term.writeln(dim(`Connecting to ${c.name} on ${c.srv}${c.srv === state.me.node ? '' : ` through ${state.me.node}`}…`));
  ws.onopen = () => { if (termWs === ws) { term.reset(); term.focus(); } };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'o') term.write(m.d);
    else if (m.t === 'exit') term.writeln('\r\n' + dim(`[shell exited${m.code != null ? ` with code ${m.code}` : ''}. Click Reconnect for a new one.]`));
    else if (m.t === 'error') term.writeln('\r\n' + red(m.msg));
  };
  ws.onclose = () => { if (termWs === ws) { termWs = null; term.writeln('\r\n' + dim('[disconnected]')); } };
}
$('termReconnect').onclick = () => { const c = cur(); if (c && !c.isStack) { renderTermMeta(); connectTerm(c); } };
$('shellSel').onchange = () => $('termReconnect').click();

// Logs
let logWs = null, logLines = [], logRetry = null;
const LOG_MAX = 3000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function levelOf(l) {
  if (/\b(ERROR|ERR|FATAL|CRIT(ICAL)?|PANIC|EMERG)\b|level=(error|fatal)|"level":\s*"(error|fatal)"/i.test(l)) return 'ERROR';
  if (/\b(WARN|WARNING)\b|level=warn|"level":\s*"warn/i.test(l)) return 'WARN';
  if (/\b(DEBUG|TRACE|DBG)\b|level=(debug|trace)|"level":\s*"(debug|trace)"/i.test(l)) return 'DEBUG';
  return 'INFO';
}
const order = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
function logVisible(l) {
  if (order[l.lv] < order[$('logLevel').value]) return false;
  const q = $('logFilter').value.trim().toLowerCase();
  return !q || l.l.toLowerCase().includes(q);
}
const stamp = t => new Date(t).toISOString().replace('T', ' ').slice(0, 23);
function lineHtml(l) {
  const q = $('logFilter').value.trim();
  let m = esc(l.l);
  if (q) m = m.replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), s => `<mark>${s}</mark>`);
  return `<div class="ll lv-${l.lv}"><span class="ts">${stamp(l.ts)}</span><span class="lv">${l.lv}</span><span class="msg">${m}</span></div>`;
}
function renderLogs(extra = '') {
  const arr = logLines.filter(logVisible);
  $('logs').innerHTML = (arr.map(lineHtml).join('') || (extra ? '' : '<div class="empty">No log lines yet.</div>')) + extra;
  $('lcount').textContent = `${arr.length} lines`;
  if (state.follow) $('logs').scrollTop = $('logs').scrollHeight;
}
function appendLogs(batch) {
  logLines.push(...batch);
  let trimmed = false;
  if (logLines.length > LOG_MAX) { logLines.splice(0, logLines.length - LOG_MAX); trimmed = true; }
  if (state.paused) return;
  if (trimmed) return renderLogs();
  const box = $('logs');
  box.querySelector('.empty')?.remove();
  box.insertAdjacentHTML('beforeend', batch.filter(logVisible).map(lineHtml).join(''));
  while (box.childElementCount > LOG_MAX) box.firstElementChild.remove();
  $('lcount').textContent = `${box.childElementCount} lines`;
  if (state.follow) box.scrollTop = box.scrollHeight;
}
function setLive(on, text) { $('live').classList.toggle('off', !on); $('liveTxt').textContent = text; }
function closeLogs() { clearTimeout(logRetry); if (logWs) { logWs.onclose = null; logWs.close(); logWs = null; } }
function connectLogs(c) {
  closeLogs();
  logLines = [];
  if (!isUp(c)) { renderLogs(`<div class="ll sep">${esc(c.srv)} is unreachable. Logs are not cached between nodes.</div>`); setLive(false, 'node offline'); return; }
  renderLogs();
  setLive(false, 'connecting');
  const ws = new WebSocket(wsUrl(N(c.srv, `/ws/logs/${c.id}?tail=500`)));
  logWs = ws;
  ws.onopen = () => setLive(true, c.status !== 'running' ? 'stopped · showing last lines' : c.srv === state.me.node ? 'streaming' : `streaming via ${state.me.node}`);
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'lines') appendLogs(m.lines.map(x => { const l = x.l.replace(ANSI, ''); return { ts: x.ts, l, lv: levelOf(l) }; }));
    else if (m.t === 'end') setLive(false, 'log stream ended');
    else if (m.t === 'error') { setLive(false, 'error'); $('logs').insertAdjacentHTML('beforeend', `<div class="ll sep err-text">${esc(m.msg)}</div>`); }
  };
  ws.onclose = () => {
    if (logWs !== ws) return;
    logWs = null;
    setLive(false, 'disconnected · retrying');
    logRetry = setTimeout(() => { const now = cur(); if (now?.uid === c.uid && !$('view-inspect').hidden) { streamKey = null; syncStreams(); } }, 4000);
  };
}
$('logFilter').addEventListener('input', () => renderLogs());
$('logLevel').addEventListener('change', () => renderLogs());
$('pauseBtn').onclick = e => {
  state.paused = !state.paused;
  e.currentTarget.setAttribute('aria-pressed', state.paused);
  e.currentTarget.textContent = state.paused ? 'Resume' : 'Pause';
  if (!state.paused) renderLogs();
};
$('followBtn').onclick = e => { state.follow = !state.follow; e.currentTarget.setAttribute('aria-pressed', state.follow); if (state.follow) $('logs').scrollTop = $('logs').scrollHeight; };
$('tsBtn').onclick = e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', on); $('logs').classList.toggle('no-ts', !on); };
$('logClear').onclick = () => { logLines = []; renderLogs(); };
$('logs').addEventListener('wheel', e => { if (e.deltaY < 0 && state.follow) { state.follow = false; $('followBtn').setAttribute('aria-pressed', 'false'); } }, { passive: true });

/* ---------- Cluster page ---------- */
function showCluster(focus) {
  state.view = 'cluster';
  state.focusNode = focus;
  renderView(); renderCluster();
  if (focus) requestAnimationFrame(() => document.getElementById('node-' + focus)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
function meter(label, used, total, text) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return `<div class="meter"><span>${label}</span><span class="bar"><i style="width:${pct.toFixed(0)}%"></i></span><span>${text}</span></div>`;
}
const ENTRY_LABELS = { sharedEnv: 'shared.env', 'auth.admin': 'Admin password', 'auth.oidc': 'Single sign-on settings', 'auth.session': 'Session length' };
const entryLabel = k => ENTRY_LABELS[k] || (k.startsWith('node:') ? `Address of ${k.slice(5)}` : k.startsWith('conflict:') ? `Collision in ${ENTRY_LABELS[k.split(':')[1]] || k.split(':')[1]}` : k);
function renderCluster() {
  const cl = state.cluster;
  const view = $('view-cluster');
  if (!cl) { view.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const self = cl.nodes.find(n => n.self);
  const on = cl.nodes.filter(n => n.online);
  const inSync = cl.nodes.filter(n => n.online && n.digest === cl.digest).length;
  const c = cur();
  let h = `<div class="cl-head"><div><h1>Cluster</h1><div class="cl-sub"><span>${cl.nodes.length} node${cl.nodes.length > 1 ? 's' : ''} · ${on.length} online</span>${cl.vip ? `<span>Floating IP <code>${esc(cl.vip)}</code></span>` : ''}<span>Config <code>v${cl.ver}</code> · same on ${inSync}/${cl.nodes.length}</span></div></div><span class="spacer"></span>${can('admin') ? '<button class="btn" id="openSettings">Sign-in settings</button>' : ''}${c ? `<button class="btn" id="clBack">← Back to ${esc(c.name)}</button>` : ''}</div>`;
  const drift = cl.nodes.filter(n => n.envDrift?.length);
  if (drift.length && can('admin')) h += `<div class="banner"><span><b>.env differs from the cluster's sign-in settings</b> on ${drift.map(n => `${esc(n.id)} (${esc(n.envDrift.join(', '))})`).join('; ')}. The cluster's settings are used; update or remove those lines from that node's .env.</span></div>`;
  const bg = cl.nodes.filter(n => n.breakGlass).map(n => n.id);
  if (bg.length) h += `<div class="banner"><span><b>Break-glass password sign-in is on</b> on ${esc(bg.join(', '))}. Anyone with the admin password can sign in there and manage every node. Remove <code>BREAK_GLASS</code> from that node's .env and restart SelfCluster once single sign-on works again.</span></div>`;
  h += '<div class="nodes">' + cl.nodes.map(n => {
    const ho = n.host;
    const cfg = !n.online ? [`v${n.ver ?? '?'} · last known`, 'warn'] : n.digest === cl.digest ? [`v${n.ver} · in sync`, 'ok'] : [`v${n.ver} · syncing`, 'warn'];
    const agentOld = n.agent && self && n.agent !== self.agent;
    const cpuPct = ho ? Math.min(100, (ho.load / ho.cpus) * 100) : 0;
    return `<article class="node${state.focusNode === n.id ? ' focus' : ''}" id="node-${esc(n.id)}" style="--hc:${hc(n.id)}">
      <header><span class="swatch"></span><h2>${esc(n.id)}</h2><span class="pill ${n.online ? 'running' : 'unreachable'}">${n.online ? 'online' : n.neverSeen ? 'never reached' : 'unreachable'}</span>${n.self ? '<span class="badge here">you are here</span>' : ''}${n.breakGlass ? '<span class="badge warn" title="BREAK_GLASS=true in this node&#39;s .env: the admin password works here">break-glass on</span>' : ''}</header>
      <div class="addr">${esc(n.url)}${ho?.os ? ` · ${esc(ho.os)}` : ''}${ho ? ` · ${ho.cpus} CPU · ${bytes(ho.memTotal)}` : ''}</div>
      <dl class="kv">
        <dt>Latency from ${esc(state.me.node)}</dt><dd>${n.self ? 'local' : n.online ? `${n.latency ?? '?'} ms` : '—'}</dd>
        <dt>Last heartbeat</dt><dd class="${n.online ? '' : 'bad'}">${n.self ? 'now' : n.lastSeen ? ago(n.lastSeen) : 'never'}</dd>
        <dt>Cluster config</dt><dd class="${cfg[1]}">${cfg[0]}</dd>
        <dt>SelfCluster</dt><dd class="${agentOld ? 'warn' : ''}">${esc(n.agent || '?')}${agentOld ? ` · this node runs ${esc(self.agent)}` : ''}</dd>
        <dt>Docker Engine</dt><dd>${esc(ho?.engine || '?')}</dd>
        <dt>Containers</dt><dd>${n.containers ? `${n.containers.running} running · ${n.containers.total - n.containers.running} other` : '?'}</dd>
        ${n.error && !n.online ? `<dt>Last error</dt><dd class="bad">${esc(n.error)}</dd>` : ''}
      </dl>
      <div class="meters">${ho ? meter('Load', cpuPct, 100, `${ho.load.toFixed(2)} / ${ho.cpus}`) + meter('RAM', ho.memUsed, ho.memTotal, `${bytes(ho.memUsed)} / ${bytes(ho.memTotal)}`) + (ho.disk ? meter('Disk', ho.disk.used, ho.disk.total, `${bytes(ho.disk.used)} / ${bytes(ho.disk.total)}`) : '') : ''}</div>
      <footer>
        ${n.self ? '<button class="btn sm" disabled>Connected here</button>' : `<button class="btn sm" data-cl-via="${esc(n.id)}" ${n.online ? '' : 'disabled'}>Connect via this node</button>`}
        <button class="btn sm" data-cl-show="${esc(n.id)}">Show containers</button>
        ${!n.self && !n.online && can('admin') ? `<button class="btn sm danger" data-cl-forget="${esc(n.id)}">Remove from cluster</button>` : ''}
      </footer>
    </article>`;
  }).join('') + '</div>';
  const entries = [...cl.entries].filter(e => !e.deleted).sort((a, b) => b.ts - a.ts);
  h += `<div class="cl-grid">
    <div class="panel"><div class="panel-bar"><span class="panel-title">Shared config</span><span class="path">every node holds a copy · newest change wins</span></div>
      <div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Version</th><th>Changed by</th><th>When</th></tr></thead><tbody>
      ${entries.map(e => `<tr><td>${esc(entryLabel(e.key))}</td><td class="num">v${e.v}</td><td>${esc(e.by)}</td><td class="num">${ago(e.ts)}</td></tr>`).join('')}
      <tr><td>Activity log on ${esc(cl.self)}</td><td class="num">${cl.auditCount.toLocaleString('en-US')} entries</td><td>append-only</td><td class="num">${cl.audit[0] ? ago(cl.audit[0].t) : '—'}</td></tr>
      </tbody></table></div></div>
    <div class="panel"><div class="panel-bar"><span class="panel-title">Recent activity</span><span class="path">all reachable nodes</span></div>
      <ul class="audit">${cl.audit.slice(0, 30).map(a => `<li><time>${hhmm(a.t)}</time><span>${esc(a.msg)} <span class="who">· ${esc(a.who)} via ${esc(a.via)}</span></span></li>`).join('') || '<li><span class="who">Nothing yet</span></li>'}</ul></div>
  </div>
  ${can('admin') ? `<div class="panel"><div class="panel-bar"><span class="panel-title">Add a node</span></div>
    <div class="join">
      <span><b>1.</b> On the new machine, copy this project, fill in <code>.env</code> like this, and run <code>docker compose up -d</code>. That's all it needs: sign-in settings, <code>shared.env</code> and the node list come from the cluster.</span>
      <pre class="code" id="joinCmd">NODE_ID=&lt;a short unique name, e.g. pi-garage&gt;
NODE_URL=http://&lt;its LAN or Tailscale address&gt;:7443
CLUSTER_SECRET=&lt;same as this cluster&gt;</pre>
      <div class="join-row"><button class="btn sm" id="copyJoin">Copy</button></div>
      <span><b>2.</b> Enter its address. ${esc(state.me.node)} checks that it answers with this cluster's secret, then every node learns about it, and it learns about every node, within a few seconds.</span>
      <form class="join-row" id="addNodeForm">
        <input class="search" id="addNodeUrl" style="flex:1;min-width:220px" placeholder="http://192.168.1.30:7443" autocomplete="off" required aria-label="Address of the new node">
        <button class="btn primary sm" type="submit" id="addNodeBtn">Add node</button>
      </form>
      <div class="form-error" id="addNodeError"></div>
    </div></div>` : ''}`;
  const top = view.scrollTop;
  const typed = document.getElementById('addNodeUrl')?.value || '', hadFocus = document.activeElement?.id === 'addNodeUrl';
  const lastErr = document.getElementById('addNodeError')?.textContent || '';
  view.innerHTML = h;
  view.scrollTop = top;
  const inp = document.getElementById('addNodeUrl');
  if (inp) { inp.value = typed; if (hadFocus) inp.focus(); $('addNodeError').textContent = lastErr; }
  if (addingNode && $('addNodeBtn')) { $('addNodeBtn').disabled = true; $('addNodeBtn').textContent = 'Checking…'; }
}
let addingNode = false;
$('view-cluster').addEventListener('submit', async e => {
  if (e.target.id !== 'addNodeForm') return;
  e.preventDefault();
  const url = $('addNodeUrl').value.trim();
  $('addNodeError').textContent = '';
  addingNode = true;
  $('addNodeBtn').disabled = true; $('addNodeBtn').textContent = 'Checking…';
  try {
    const n = await api('/api/cluster/nodes', { method: 'POST', body: { url } });
    $('addNodeUrl').value = '';
    toast(`Added ${n.id}. Every node knows about it now; its containers appear within a few seconds.`, 5000);
    await Promise.all([refreshCluster(), refreshOverview()]);
  } catch (err) {
    $('addNodeError').textContent = err.message;
  } finally {
    addingNode = false;
    if ($('addNodeBtn')) { $('addNodeBtn').disabled = false; $('addNodeBtn').textContent = 'Add node'; }
  }
});
$('view-cluster').addEventListener('click', async e => {
  if (e.target.closest('#clBack')) { state.view = 'container'; renderView(); return; }
  if (e.target.closest('#openSettings')) { showSettings(); return; }
  const v = e.target.closest('[data-cl-via]');
  if (v && !v.disabled) { handoff(v.dataset.clVia); return; }
  const s = e.target.closest('[data-cl-show]');
  if (s) {
    const id = s.dataset.clShow;
    if (opts.tree === 'picker') state.pickSrv = id;
    else { state.srv = id; state.open.add('srv:' + id); }
    renderSrvFilter(); renderTree();
    const first = state.ctrs.find(c => c.srv === id);
    if (first) select(first.uid); else { state.view = 'container'; renderView(); }
    $('app').classList.add('side-open');
    return;
  }
  const f = e.target.closest('[data-cl-forget]');
  if (f) {
    const id = f.dataset.clForget;
    const ok = await ask(`Remove ${id} from the cluster?`, `<p>The other nodes stop trying to reach <b>${esc(id)}</b> and drop its cached files. Nothing is changed on ${esc(id)} itself; if SelfCluster starts there again it rejoins.</p>`, 'Remove node');
    if (!ok) return;
    try { await api('/api/cluster/forget', { method: 'POST', body: { id } }); toast(`${id} removed from the cluster`); await Promise.all([refreshCluster(), refreshOverview()]); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.closest('#copyJoin')) {
    const pre = $('joinCmd');
    const fallback = () => { const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected. Press Ctrl+C or ⌘C to copy.'); };
    try { navigator.clipboard.writeText(pre.textContent).then(() => toast('Copied'), fallback); } catch { fallback(); }
  }
});

/* ---------- Sign-in settings (shared by every node) ---------- */
async function showSettings(message) {
  state.view = 'settings';
  renderView();
  if (!state.settings) $('view-settings').innerHTML = '<div class="empty">Loading…</div>';
  try { state.settings = await api('/api/settings'); renderSettings(); } catch (e) { $('view-settings').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  if (message) toast(message, 5000);
}
const changedLine = x => (x?.by ? `Last changed by <b>${esc(x.by)}</b> ${ago(x.ts)}` : x?.source === 'env' ? 'From this node\'s .env (not saved to the cluster yet)' : 'Not set');
function roleInputs(o, r) {
  const g = (o.roles?.[r]?.groups || []).join(', '), u = (o.roles?.[r]?.users || []).join(', ');
  return `<div class="role-row"><span class="opt-k">${r}</span>
    <input class="search" id="st-${r}-groups" placeholder="groups, comma separated" value="${esc(g)}" aria-label="${r} groups">
    <input class="search" id="st-${r}-users" placeholder="users or emails" value="${esc(u)}" aria-label="${r} users"></div>`;
}
function renderSettings() {
  const st = state.settings, o = st.oidc, el = $('view-settings');
  const field = (id, label, value, attrs = '') => `<label class="field">${label}<input id="${id}" value="${esc(value ?? '')}" ${attrs}></label>`;
  let h = `<div class="cl-head"><div><h1>Sign-in settings</h1><div class="cl-sub"><span>Shared by every node. Saving checks every reachable node first, so two people can't overwrite each other.</span></div></div><span class="spacer"></span><button class="btn" id="stBack">← Cluster</button></div>`;
  for (const c of st.collisions) {
    const who = (by, node) => `${esc(by)}${node ? ` on ${esc(node)}` : ''}`;
    h += `<div class="banner err"><span><b>Two changes to ${esc(ENTRY_LABELS[c.key] || c.key)} were made without seeing each other</b>: ${who(c.loserBy, c.loserNode)} (${ago(c.loserTs)}) and ${who(c.winnerBy, c.winnerNode)} (${ago(c.winnerTs)}), probably while the nodes couldn't reach each other. The change from ${who(c.winnerBy, c.winnerNode)} is in use.</span>
      <button class="btn" data-col="${esc(c.id)}" data-act="keep">Keep that one</button><button class="btn" data-col="${esc(c.id)}" data-act="restore">Use the one from ${who(c.loserBy, c.loserNode)}</button></div>`;
  }
  const drift = (state.cluster?.nodes || []).filter(n => n.envDrift?.length);
  if (drift.length) h += `<div class="banner"><span><b>Some nodes have different values in .env:</b> ${drift.map(n => `${esc(n.id)} (${esc(n.envDrift.join(', '))})`).join('; ')}. The settings below are what every node uses. .env only seeds a new cluster, so remove or update those lines.</span></div>`;

  h += `<div class="panel"><div class="panel-bar"><span class="panel-title">Single sign-on (OIDC)</span><span class="status-line">${o.enabled ? `On: <b>${esc(o.label)}</b> · ` : 'Off · '}${changedLine(o)}</span></div>
    <form id="stOidc">
      <div class="form-grid">
        ${field('st-issuer', 'Issuer URL', o.issuer, 'placeholder="https://auth.example.com" required')}
        ${field('st-clientId', 'Client ID', o.clientId, 'required autocomplete="off"')}
        <label class="field">Client secret<input id="st-clientSecret" type="password" autocomplete="new-password" placeholder="${o.clientSecretSet ? 'Saved. Leave empty to keep it' : 'Required for confidential clients'}"></label>
        ${field('st-label', 'Button label', o.label, 'placeholder="e.g. Authelia"')}
        ${field('st-scopes', 'Scopes', o.scopes, 'placeholder="openid profile email groups"')}
        ${field('st-usernameClaim', 'Username claim', o.usernameClaim, 'placeholder="preferred_username"')}
        ${field('st-groupsClaim', 'Groups claim', o.groupsClaim, 'placeholder="groups (or realm_access.roles)"')}
        <label class="field">Accounts matching no role<select id="st-defaultRole">${['none', 'viewer', 'operator', 'admin'].map(r => `<option value="${r}" ${(o.defaultRole || 'none') === r ? 'selected' : ''}>${r === 'none' ? 'refused' : r}</option>`).join('')}</select></label>
        <div class="wide"><p class="opt-k" style="margin:0 0 6px">Roles · highest match wins</p>${['admin', 'operator', 'viewer'].map(r => roleInputs(o, r)).join('<div style="height:6px"></div>')}</div>
        <div class="wide"><p class="hint">Register these redirect URIs on the identity provider (one per address people open SelfCluster at):</p><pre class="code">${esc([...new Set([...st.redirectUris, ...st.publicRedirectUris])].join('\n'))}</pre></div>
      </div>
      <div class="form-foot">
        <button class="btn primary" type="submit">Test sign-in and save</button>
        ${o.enabled ? '<button class="btn danger" type="button" id="stOidcOff">Turn off single sign-on</button>' : ''}
        <p class="hint">You'll sign in with these settings at the identity provider. They're saved for every node only if you come back as <b>admin</b>, so a mistake can't lock anyone out.</p>
        <div class="form-error" id="stOidcErr"></div>
      </div>
    </form></div>`;

  h += `<div class="cl-grid">
    <div class="panel"><div class="panel-bar"><span class="panel-title">Admin password</span><span class="status-line">${changedLine(st.admin)}</span></div>
      <form id="stAdmin"><div class="form-grid">
        ${field('st-adminUser', 'User name', st.admin.user, 'required autocomplete="username"')}
        <label class="field">New password<input id="st-adminPass" type="password" minlength="10" required autocomplete="new-password"></label>
        <label class="field">Repeat it<input id="st-adminPass2" type="password" minlength="10" required autocomplete="new-password"></label>
      </div><div class="form-foot"><button class="btn primary" type="submit">Save password</button>
        <p class="hint">${o.enabled ? 'Single sign-on is on, so this password only works on a node with <code>BREAK_GLASS=true</code> in its .env.' : 'Used to sign in while single sign-on is off.'} Stored as a scrypt hash, encrypted, on every node.</p>
        <div class="form-error" id="stAdminErr"></div></div></form></div>
    <div class="panel"><div class="panel-bar"><span class="panel-title">Sessions</span><span class="status-line">${changedLine(st.session)}</span></div>
      <form id="stSession"><div class="form-grid">
        ${field('st-hours', 'Sign-ins last (hours)', st.session.hours, 'type="number" min="1" max="2160" required')}
      </div><div class="form-foot"><button class="btn primary" type="submit">Save</button>
        <p class="hint">Applies to new sign-ins. Changing someone's role or removing their access takes effect at their next sign-in. Break-glass sign-ins always last 1 hour.</p>
        <div class="form-error" id="stSessionErr"></div></div></form></div>
  </div>`;
  el.innerHTML = h;
}
const splitList = v => v.split(',').map(x => x.trim()).filter(Boolean);
async function settingsCall(errId, fn) {
  $(errId).textContent = '';
  try { return await fn(); } catch (e) {
    if (e.status === 409 && e.data?.settings) {
      state.settings = e.data.settings; renderSettings();
      $(errId).textContent = `${e.message}. The form now shows the latest saved values; make your change again if it's still needed.`;
    } else $(errId).textContent = e.message;
    return null;
  }
}
$('view-settings').addEventListener('click', async e => {
  if (e.target.closest('#stBack')) { showCluster(null); return; }
  if (e.target.closest('#stOidcOff')) {
    const ok = await ask('Turn off single sign-on?', '<p>Every node goes back to the admin password for sign-in. People signed in with single sign-on stay signed in until their session ends.</p>', 'Turn off');
    if (!ok) return;
    const r = await settingsCall('stOidcErr', () => api('/api/settings/oidc/disable', { method: 'POST', body: { v: state.settings.oidc.v } }));
    if (r) { state.settings = r; renderSettings(); toast('Single sign-on is off on every node'); }
    return;
  }
  const b = e.target.closest('[data-col]');
  if (b) {
    const r = await settingsCall('stOidcErr', () => api(`/api/settings/collisions/${enc(b.dataset.col)}/${b.dataset.act}`, { method: 'POST' }));
    if (r) { state.settings = r; renderSettings(); toast('Resolved'); }
  }
});
$('view-settings').addEventListener('submit', async e => {
  e.preventDefault();
  const st = state.settings;
  if (e.target.id === 'stAdmin') {
    if ($('st-adminPass').value !== $('st-adminPass2').value) { $('stAdminErr').textContent = 'The two passwords are different'; return; }
    const r = await settingsCall('stAdminErr', () => api('/api/settings/admin', { method: 'PUT', body: { user: $('st-adminUser').value, password: $('st-adminPass').value, v: st.admin.v } }));
    if (r) { state.settings = r; renderSettings(); toast('Admin password saved for every node'); }
  } else if (e.target.id === 'stSession') {
    const r = await settingsCall('stSessionErr', () => api('/api/settings/session', { method: 'PUT', body: { hours: Number($('st-hours').value), v: st.session.v } }));
    if (r) { state.settings = r; renderSettings(); toast('Session length saved'); }
  } else if (e.target.id === 'stOidc') {
    const val = id => $(id).value.trim();
    const oidc = {
      issuer: val('st-issuer'), clientId: val('st-clientId'), clientSecret: $('st-clientSecret').value, label: val('st-label'),
      scopes: val('st-scopes'), usernameClaim: val('st-usernameClaim'), groupsClaim: val('st-groupsClaim'), defaultRole: $('st-defaultRole').value,
      roles: Object.fromEntries(['admin', 'operator', 'viewer'].map(r => [r, { groups: splitList($(`st-${r}-groups`).value), users: splitList($(`st-${r}-users`).value) }])),
    };
    const r = await settingsCall('stOidcErr', () => api('/api/settings/oidc/test', { method: 'POST', body: { oidc, v: st.oidc.v } }));
    if (r?.url) location.href = r.url;
  }
});

/* ---------- New stack ---------- */
const TEMPLATE = `services:
  app:
    image: nginx:1.27-alpine
    restart: unless-stopped
    env_file:
      - path: ../shared.env
        required: false
    ports:
      - "8088:80"
`;
$('newStackBtn').onclick = () => {
  const online = state.nodes.filter(nodeUp);
  $('nsNode').innerHTML = online.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
  const c = cur();
  $('nsNode').value = c && nodeUp(c.srv) ? c.srv : state.me.node;
  $('nsName').value = '';
  $('nsCompose').value = TEMPLATE;
  $('nsError').textContent = '';
  $('newStackModal').hidden = false;
  $('nsName').focus();
};
$('nsCancel').onclick = () => { $('newStackModal').hidden = true; };
$('newStackForm').addEventListener('submit', async e => {
  e.preventDefault();
  const up = e.submitter?.dataset.up === '1';
  const node = $('nsNode').value, name = $('nsName').value.trim();
  $('nsError').textContent = '';
  try {
    if (up) toast(`Creating ${name} on ${node} and running docker compose up…`, 15 * 60e3);
    await api(N(node, '/stacks'), { method: 'POST', body: { name, files: [{ name: 'compose.yaml', content: $('nsCompose').value }], up } });
    $('newStackModal').hidden = true;
    toast(up ? `Deployed ${name} on ${node}` : `Created ${name} on ${node}`);
    state.open.add('srv:' + node); state.open.add(`${node}/${name}`); saveOpen();
    await refreshOverview();
    const first = state.ctrs.find(x => x.srv === node && x.stack === name);
    select(first ? first.uid : `stack:${node}/${name}`);
  } catch (err) {
    toast('');
    $('nsError').textContent = err.message;
    if (err.data?.output) showOutput(`docker compose up failed for ${name}`, err.data.output);
    refreshOverview();
  }
});

/* ---------- Dialogs ---------- */
function ask(title, bodyHtml, okLabel = 'OK', getValue = null) {
  return new Promise(resolve => {
    $('askTitle').textContent = title;
    $('askBody').innerHTML = bodyHtml;
    $('askOk').textContent = okLabel;
    $('askOk').hidden = false;
    $('askCancel').textContent = 'Cancel';
    $('askModal').hidden = false;
    (document.getElementById('askInput') || $('askOk')).focus();
    const done = ok => {
      const val = ok ? (getValue ? getValue() : true) : (getValue ? null : false);
      $('askModal').hidden = true;
      $('askOk').onclick = $('askCancel').onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onKey = ev => { if (ev.key === 'Enter' && document.activeElement?.id === 'askInput') { ev.preventDefault(); done(true); } };
    document.addEventListener('keydown', onKey, true);
    $('askOk').onclick = () => done(true);
    $('askCancel').onclick = () => done(false);
  });
}
function showOutput(title, text) {
  $('askTitle').textContent = title;
  $('askBody').innerHTML = `<pre class="out">${esc(text || 'No output')}</pre>`;
  $('askOk').hidden = true;
  $('askCancel').textContent = 'Close';
  $('askModal').hidden = false;
  $('askCancel').onclick = () => { $('askModal').hidden = true; $('askOk').hidden = false; };
}

/* ---------- Popovers ---------- */
function openPop(pop, btn) {
  closePops();
  pop.hidden = false;
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.maxHeight = (innerHeight - r.bottom - 20) + 'px';
  btn.setAttribute('aria-expanded', 'true');
}
function closePops() {
  ['pop', 'viaMenu', 'ctxMenu'].forEach(id => { $(id).hidden = true; });
  ['optsBtn', 'viaBtn'].forEach(id => $(id).setAttribute('aria-expanded', 'false'));
}
$('optsBtn').onclick = e => { e.stopPropagation(); if ($('pop').hidden) openPop($('pop'), e.currentTarget); else closePops(); };
$('viaBtn').onclick = e => { e.stopPropagation(); if ($('viaMenu').hidden) { renderViaMenu(); openPop($('viaMenu'), e.currentTarget); } else closePops(); };
document.addEventListener('click', e => { if (!e.target.closest('.pop')) closePops(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closePops(); closeDrawer();
  $('diffModal').hidden = true; $('newStackModal').hidden = true;
  if (!$('askModal').hidden) $('askCancel').click();
});
$('diffModal').addEventListener('click', e => { if (e.target === $('diffModal')) $('diffModal').hidden = true; });
$('signOut').onclick = async () => {
  let r = null;
  try { r = await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  if (r?.redirect) location.href = r.redirect; else location.reload();
};

/* ---------- UI options ---------- */
function applyOpts() {
  const rootEl = document.documentElement;
  if (opts.theme === 'system') rootEl.removeAttribute('data-theme'); else rootEl.setAttribute('data-theme', opts.theme);
  $('app').classList.toggle('density-compact', opts.density === 'compact');
  $('app').style.setProperty('--side-w', opts.side + 'px');
  rootEl.style.setProperty('--editor-size', opts.font + 'px');
  $('composeSplit').classList.toggle('row', opts.envpos === 'side');
  $('inspectSplit').classList.toggle('row', opts.inspect === 'side');
  $('logs').classList.toggle('wrap-logs', opts.wrap === 'wrap');
  $('stats').hidden = opts.stats === 'hide';
  document.querySelectorAll('#pop .seg').forEach(s => [...s.children].forEach(b => b.setAttribute('aria-pressed', b.dataset.v === opts[s.dataset.opt])));
  try { localStorage.setItem('selfcluster-ui', JSON.stringify(opts)); } catch { /* ignore */ }
}
$('pop').addEventListener('click', e => {
  e.stopPropagation();
  const b = e.target.closest('.seg button');
  if (!b) return;
  const key = b.parentElement.dataset.opt;
  opts[key] = b.dataset.v;
  if (key === 'envpos') $('composeSplit').querySelector('.pane-a').style.flexBasis = '';
  if (key === 'inspect') $('inspectSplit').querySelector('.pane-a').style.flexBasis = '';
  if (key === 'tree' && opts.tree === 'picker') state.pickSrv = cur()?.srv || state.me.node;
  applyOpts(); renderSrvFilter(); renderTree();
  gutter(ct, $('composeGutter')); gutter(et, $('envGutter'));
  setTimeout(fitTerm, 50);
});

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast');
  clearTimeout(toastTimer);
  if (!msg) { t.classList.remove('show'); return; }
  t.textContent = msg;
  t.classList.add('show');
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Selection ---------- */
function select(uid) {
  const prevKey = cur() ? docKey(cur()) : null;
  state.sel = uid;
  state.view = 'container';
  const c = cur();
  if (!c) { renderView(); return; }
  if (c.isStack) state.tab = 'compose';
  if (opts.tree === 'picker' && state.pickSrv !== c.srv) { state.pickSrv = c.srv; renderSrvFilter(); }
  if (c.stack) { state.open.add('srv:' + c.srv); state.open.add(`${c.srv}/${c.stack}`); state.open.add('stack:' + c.stack); }
  try { localStorage.setItem('selfcluster-sel', uid); } catch { /* ignore */ }
  setTab(state.tab);
  renderTree(); renderHead();
  const key = docKey(c);
  if (docs.has(key)) renderEditors(prevKey !== key);
  loadDocFor(c);
}
function pickDefault() {
  let saved = null;
  try { saved = localStorage.getItem('selfcluster-sel'); } catch { /* ignore */ }
  if (saved) { state.sel = saved; if (cur()) return select(state.sel); }
  const me = state.me.node;
  const first = state.ctrs.find(c => c.srv === me && c.status === 'running' && c.stack && !c.self)
    || state.ctrs.find(c => c.srv === me) || state.ctrs[0];
  if (first) return select(first.uid);
  const st = state.stacks[0];
  if (st) return select(`stack:${st.srv}/${st.id}`);
  state.sel = null;
  $('mainEmptyText').innerHTML = `No stacks or containers yet. Click <b>+ New stack</b>, or put a folder with a compose.yaml in ${esc(state.me.stacksDir)} on any node.`;
  renderView();
}

/* ---------- Refresh loops ---------- */
async function refreshOverview() {
  try {
    const ov = await api('/api/overview');
    rebuild(ov);
    state.loaded = true;
    renderSrvFilter(); renderTree(); renderTop();
    const c = cur();
    if (!c) { if (state.sel) { state.sel = null; } pickDefault(); return; }
    renderHead();
    syncStreams();
    if (!$('view-compose').hidden) renderDirty();
  } catch (e) { if (e.status !== 401) console.warn('overview', e.message); }
}
async function refreshCluster() {
  try {
    state.cluster = await api('/api/cluster');
    const s = state.cluster.sharedEnv;
    if (shared.edit === null && !shared.conflict) shared = { ...shared, value: s.value, v: s.v, by: s.by, ts: s.ts };
    else if (!shared.conflict) shared = { ...shared, v: shared.v, by: s.by, ts: s.ts };
    renderTop();
    if (state.view === 'cluster') renderCluster();
    if (curDoc()?.envActive === '__shared' && shared.edit === null) loadEnv();
  } catch (e) { if (e.status !== 401) console.warn('cluster', e.message); }
}

/* ---------- Sign-in & boot ---------- */
let loginError = '';
async function showLogin() {
  if (!$('login').hidden) return;
  $('login').hidden = false;
  let ac = { password: true, oidc: null };
  try { ac = await api('/api/auth-config', { quiet401: true }); } catch { /* fall back to the password form */ }
  $('loginNode').textContent = `Sign in to ${ac.node || location.host}.`;
  $('loginError').textContent = loginError;
  const sso = $('ssoBtn');
  sso.hidden = !ac.oidc;
  if (ac.oidc) {
    sso.textContent = `Sign in with ${ac.oidc.label}`;
    sso.href = `/auth/oidc/login?return=${enc(location.pathname)}`;
  }
  $('loginForm').hidden = !ac.password;
  $('loginOr').hidden = !(ac.oidc && ac.password);
  $('loginOr').firstElementChild.textContent = ac.breakGlass ? 'or, in an emergency, the break-glass admin password' : 'or use the admin password';
  $('loginSubmit').classList.toggle('primary', !ac.oidc);
  if (!ac.password && !ac.oidc) $('loginError').textContent = ac.configured === false ? 'This node has no sign-in settings yet. Add it to the cluster from another node (Cluster → Add a node), and it receives them.' : 'Password sign-in is off on this node and no single sign-on is set up.';
  setTimeout(() => (ac.oidc ? sso : $('loginPass')).focus(), 0);
}
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { user: $('loginUser').value, password: $('loginPass').value }, quiet401: true });
    $('loginPass').value = '';
    loginError = '';
    $('login').hidden = true;
    boot();
  } catch (err) { $('loginError').textContent = err.message; }
});

let timers = false;
async function boot() {
  applyOpts();
  if (location.hash.startsWith('#login-error=')) {
    loginError = decodeURIComponent(location.hash.slice(13));
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (location.hash.startsWith('#handoff=')) {
    const token = decodeURIComponent(location.hash.slice(9));
    history.replaceState(null, '', location.pathname + location.search);
    try { await api('/api/handoff/redeem', { method: 'POST', body: { token }, quiet401: true }); } catch { /* fall through to sign-in */ }
  }
  try { state.me = await api('/api/me', { quiet401: true }); }
  catch (e) { if (e.status === 401) showLogin(); else { $('mainEmpty').hidden = false; $('mainEmptyText').textContent = `Could not reach SelfCluster: ${e.message}`; } return; }
  $('login').hidden = true;
  document.title = `SelfCluster · ${state.me.node}`;
  state.pickSrv = state.me.node;
  await Promise.all([refreshCluster(), refreshOverview()]);
  if (location.hash === '#settings-saved' || location.hash === '#settings') {
    const saved = location.hash === '#settings-saved';
    history.replaceState(null, '', location.pathname + location.search);
    if (can('admin')) showSettings(saved ? 'Test sign-in worked: the single sign-on settings are saved for every node.' : undefined);
  }
  if (loginError) {
    // e.g. a test of new single sign-on settings that failed while already signed in
    const msg = loginError; loginError = '';
    if (can('admin') && /test|settings/i.test(msg)) showSettings();
    showOutput('Single sign-on', msg);
  }
  if (!timers) {
    timers = true;
    setInterval(refreshOverview, 5000);
    setInterval(refreshCluster, 5000);
    setInterval(() => { if (curDoc() && !document.hidden && cur() && isUp(cur()) && !isDocDirty(curDoc())) loadDocFor(cur()); }, 20000);
  }
}
boot();
})();
