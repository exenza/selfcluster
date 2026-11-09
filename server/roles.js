// Roles and what each may do. Checked on every /api request and WebSocket, on the node that receives
// it and again on the node that owns the containers (relayed requests carry the role, signed).
export const ROLES = ['viewer', 'operator', 'admin'];
const RANK = { viewer: 0, operator: 1, admin: 2 };
export const isRole = r => Object.hasOwn(RANK, r);
export const atLeast = (role, min) => isRole(role) && RANK[role] >= RANK[min];

const N = '\\/api\\/n\\/[^/]+';
const RULES = [
  ['GET', /^\/api\/(me|cluster|overview)$/, 'viewer'],
  ['POST', /^\/api\/handoff$/, 'viewer'],
  ['GET', new RegExp(`^${N}\\/inventory$`), 'viewer'],
  ['GET', new RegExp(`^${N}\\/stacks\\/[^/]+\\/files$`), 'viewer'],
  ['GET', new RegExp(`^${N}\\/containers\\/[^/]+\\/(readback|stats)$`), 'viewer'],
  ['WS', new RegExp(`^${N}\\/ws\\/logs\\/[^/]+$`), 'viewer'],
  ['POST', new RegExp(`^${N}\\/containers\\/[^/]+\\/(start|stop|restart|pull)$`), 'operator'],
  ['POST', new RegExp(`^${N}\\/stacks\\/[^/]+\\/(up|down|pull|validate)$`), 'operator'],
  // Everything else (editing files, shared.env, new stacks, removing containers, the terminal,
  // removing nodes) needs admin.
];

export function requiredRole(method, pathname) {
  for (const [m, re, role] of RULES) if (m === method && re.test(pathname)) return role;
  return 'admin';
}

export function denied(role, min) {
  return `Your role (${role}) can't do this; it needs ${min}. Ask an admin to change your role on the identity provider.`;
}

// Env values are secrets more often than not: only admins see them.
export function maskEnv(text) {
  return String(text).split('\n').map(line => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(.*)$/);
    return m && m[2] !== '' ? `${m[1]}********` : line;
  }).join('\n');
}
export function maskFiles(files) {
  return { ...files, masked: true, env: (files.env || []).map(f => ({ ...f, content: maskEnv(f.content), etag: null })) };
}
