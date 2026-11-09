import os from 'node:os';

const env = process.env;
const port = Number(env.PORT || 7443);
const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const noSlash = s => s.trim().replace(/\/+$/, '');

// Role mapping: OIDC_<ROLE>_GROUPS / OIDC_<ROLE>_USERS. OIDC_ALLOWED_* (from 0.2.0) mean admin.
const roleMap = {
  admin: { groups: [...list(env.OIDC_ADMIN_GROUPS), ...list(env.OIDC_ALLOWED_GROUPS)], users: [...list(env.OIDC_ADMIN_USERS), ...list(env.OIDC_ALLOWED_USERS)] },
  operator: { groups: list(env.OIDC_OPERATOR_GROUPS), users: list(env.OIDC_OPERATOR_USERS) },
  viewer: { groups: list(env.OIDC_VIEWER_GROUPS), users: list(env.OIDC_VIEWER_USERS) },
};
for (const r of Object.values(roleMap)) r.users = r.users.map(s => s.toLowerCase());
const anyGroups = Object.values(roleMap).some(r => r.groups.length);
const oidc = env.OIDC_ISSUER ? {
  issuer: noSlash(env.OIDC_ISSUER),
  clientId: (env.OIDC_CLIENT_ID || '').trim(),
  clientSecret: env.OIDC_CLIENT_SECRET || '',
  scopes: env.OIDC_SCOPES || `openid profile email${anyGroups ? ' groups' : ''}`,
  label: env.OIDC_LABEL || 'single sign-on',
  usernameClaim: env.OIDC_USERNAME_CLAIM || 'preferred_username',
  groupsClaim: env.OIDC_GROUPS_CLAIM || 'groups',
  roles: roleMap,
  // Role for accounts that match no mapping: none (refused), viewer, operator or admin.
  defaultRole: (env.OIDC_DEFAULT_ROLE || (bool(env.OIDC_ALLOW_ALL_USERS, false) ? 'admin' : 'none')).toLowerCase(),
} : null;

export const config = {
  version: '0.5.0',
  nodeId: (env.NODE_ID || os.hostname()).trim(),
  nodeUrl: noSlash(env.NODE_URL || `http://${os.hostname()}:${port}`),
  // Other addresses people use to open this node (e.g. the floating IP's DNS name). Used for OIDC redirects.
  publicUrls: list(env.PUBLIC_URLS).map(noSlash),
  port,
  stacksDir: (env.STACKS_DIR || '/opt/stacks').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR || '/data',
  socket: env.DOCKER_SOCKET_IN_CONTAINER || '/var/run/docker.sock',
  peers: list(env.PEERS).map(noSlash),
  secret: env.CLUSTER_SECRET || '',
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  // With OIDC configured the admin password only works while BREAK_GLASS=true on this node.
  breakGlass: bool(env.BREAK_GLASS, false),
  sessionHours: Math.max(1, Number(env.SESSION_HOURS || 168)),
  oidc,
  vip: (env.VIP_ADDRESS || '').split('/')[0],
  heartbeatMs: Number(env.HEARTBEAT_MS || 5000),
  offlineAfterMs: Number(env.OFFLINE_AFTER_MS || 15000),
  snapshotMs: Number(env.SNAPSHOT_MS || 30000),
};

const problems = [];
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(config.nodeId)) problems.push('NODE_ID may only contain letters, digits, ".", "_" and "-"');
if (config.secret.length < 16) problems.push('CLUSTER_SECRET must be set, at least 16 characters, and identical on every node (openssl rand -hex 32)');
// Sign-in settings are replicated between nodes, so a node joining an existing cluster needs none
// of these: it receives them. They only seed a brand-new cluster.
if (config.breakGlass) console.warn('[selfcluster] BREAK_GLASS is set: the cluster admin password works on this node even when single sign-on is on');
if (env.PASSWORD_LOGIN !== undefined) {
  console.warn('[selfcluster] PASSWORD_LOGIN is no longer used. With OIDC the admin password is off; set BREAK_GLASS=true to turn it back on.');
}
if (oidc) {
  if (!/^https?:\/\//.test(oidc.issuer)) problems.push('OIDC_ISSUER must be a full URL, e.g. https://auth.example.com');
  if (!oidc.clientId) problems.push('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');
  if (!['none', 'viewer', 'operator', 'admin'].includes(oidc.defaultRole)) problems.push('OIDC_DEFAULT_ROLE must be none, viewer, operator or admin');
  const mapped = Object.values(oidc.roles).some(r => r.groups.length || r.users.length);
  if (!mapped && oidc.defaultRole === 'none') {
    problems.push('Say who may sign in with OIDC: set OIDC_ADMIN_GROUPS / OIDC_OPERATOR_GROUPS / OIDC_VIEWER_GROUPS (or the matching *_USERS), or OIDC_DEFAULT_ROLE for every account on your identity provider');
  }
  if (oidc.issuer.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(oidc.issuer)) {
    console.warn('[selfcluster] OIDC_ISSUER uses plain http; tokens travel unencrypted');
  }
}
if (problems.length) {
  for (const p of problems) console.error(`[selfcluster] ${p}`);
  process.exit(1);
}
