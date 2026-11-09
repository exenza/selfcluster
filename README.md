# SelfCluster

A small web UI for managing Docker Compose stacks across a few homelab machines. Every node runs the same container and serves the full UI, so there is no single machine you need to reach: if one node is down, open the UI on any other. The nodes find each other and share their settings: a self-organising cluster for self-hosters.

It is not a scheduler like Kubernetes, Swarm or Nomad: you decide which machine a stack runs on, and it stays there until you move it.

- Stacks, grouped by server or by stack name, with live status
- Compose and `.env` editor. If someone else saved the file since you opened it, SelfCluster refuses the save and shows a diff
- `shared.env`: one env file replicated to every node
- Deploy (`docker compose up -d`), down, pull, plus start / stop / restart / remove for single containers
- Inspection: a real terminal (`docker exec`) and streaming logs, relayed through whichever node you're connected to
- A cluster page with heartbeats, latency, config sync state, host load, RAM and disk, and an activity log
- When a node is unreachable you can still read its stacks from a cached copy and redeploy them on another node
- An optional floating IP (keepalived) so one address always points at a live node

## How it works

```
 browser ──▶ any node ──┬── its own Docker socket and host filesystem
                        └── signed HTTP / WebSocket relay ──▶ the other nodes
```

- **Each node owns its own containers and files.** There is no central database and no consensus. A request about `pi-garage`'s containers is relayed to `pi-garage`, and only `pi-garage` changes them.
- **Only a little config is replicated:** the node list (so every node knows every node, even if the one you added it from goes away) and `shared.env`. Every entry carries a version counter, a timestamp and who wrote it. Nodes pull each other's copy on every heartbeat (every 5 s) and push on every write; the newest version wins.
- **Cached copies:** each node keeps a snapshot of every peer's inventory and stack files, refreshed every 30 s. That is what you see when a node is offline.
- **Saves check for conflicts:** each save sends a fingerprint of the file as it was when you opened it. The node that owns the file rejects the save if the file has changed since.
- **Security:** node-to-node requests are signed with HMAC-SHA256 using `CLUSTER_SECRET`, with a timestamp so a captured request can't be replayed after 60 s. Browser sessions are signed cookies that are valid on every node. Switching nodes in the UI uses a one-time token that expires after 30 s.

## Install

On each machine:

```bash
git clone https://github.com/exenza/selfcluster.git && cd selfcluster
cp .env.example .env
```

Edit `.env`:

| Variable | First node | Other nodes |
|---|---|---|
| `NODE_ID` | `nas-01` | `pi-garage`, … (unique) |
| `NODE_URL` | `http://192.168.1.10:7443` | that node's own address |
| `PEERS` | empty | empty (add the node from the UI), or any existing node's address |
| `CLUSTER_SECRET` | `openssl rand -hex 32` | **the same value** |
| `ADMIN_PASSWORD` | your choice (seeds the cluster) | not needed: it comes from the cluster |
| `STACKS_DIR` | `/opt/stacks` (new stacks go here) | any path |

Then:

```bash
docker compose up -d
```

Open `http://<node>:7443` and sign in as `admin`.

### Adding and removing nodes

Nodes form a mesh: every node knows every other node and checks on each one directly (a heartbeat every 5 s). There is no primary node and no parent/child relationship.

**To add a node:** start SelfCluster on the new machine with just its own `NODE_ID` and `NODE_URL` and the cluster's `CLUSTER_SECRET`. Then, on any existing node, open **Cluster → Add a node** and enter its address. That node:
1. checks that the new node answers and signs with the same `CLUSTER_SECRET`, and that its `NODE_ID` isn't already taken;
2. adds it to the replicated node list, which reaches every node within a heartbeat;
3. sends the new node the full list and the shared config (sign-in settings, `shared.env`), so it can be signed in to and starts checking on every other node too.

Add a third node the same way, from any node, and all three know about all three.

The node list is copied on every node. If a node disappears, the others keep their copy, still know each other, and show the missing one as unreachable. When it comes back it rejoins by itself. To drop a node for good, stop SelfCluster on it, then use **Remove from cluster** on its card.

`PEERS` in `.env` still works if you prefer setting nodes up from config files: a node with `PEERS=<address>` contacts that node at startup and joins the same way. It's only a first contact; one address is enough, and any number of nodes can use the same one.

What stays per node, in `.env`: `NODE_ID`, `NODE_URL`, `CLUSTER_SECRET` (it's what lets nodes trust each other, so it can't come from the cluster), `PUBLIC_URLS` and `BREAK_GLASS`. Everything about sign-in is shared, see below.

### Where stacks are found

SelfCluster adapts to whatever is already running. Every container started by `docker compose` (or a recent `podman-compose`) carries labels with its project name, the folder it was started from, the compose files used (including several `-f` files) and any `--env-file`. SelfCluster reads those labels, so your stacks can live anywhere: `/srv/media`, `/home/me/docker/jellyfin`, nested folders, one big compose file with overrides.

- **Discovered stacks are remembered.** After `compose down` a stack has no containers, so no labels to read. SelfCluster keeps a per-node list (in its data volume), so the stack stays visible and can be deployed again. Use **Forget stack** on a stack without containers to drop it; no files are deleted.
- **Deploys mirror the original start:** `docker compose -p <project> --project-directory <folder> -f <each original file> [--env-file …]`. The project keeps its name and its containers instead of getting a duplicate.
- **Files shown for a stack:** its compose file, any extra compose files (tagged *compose*), `*.env` files in its folder, files referenced by `env_file:` (even outside the folder), and its `--env-file`.
- **`STACKS_DIR`** (default `/opt/stacks`) is where **New stack** creates folders and where `shared.env` is written. Folders there with a compose file show up even if they were never started. The project name comes from `name:` in the file, or else the folder name.

How it gets at the files: the compose file mounts the host's `/` at `/host` in the SelfCluster container, and SelfCluster reads and writes through it. To run `docker compose`, it makes each project folder appear at its real host path inside its container (a symlink into `/host`). That way relative paths like `./config` and `../shared.env` resolve exactly as they do on the host. SelfCluster only touches the files that belong to a stack, as listed above, never arbitrary paths.

To use the cluster-wide `shared.env` in a stack:

```yaml
services:
  app:
    env_file:
      - path: /opt/stacks/shared.env   # your STACKS_DIR
        required: false
      - .env
```

What doesn't fit:

- **Not compose:** containers started with plain `docker run`, Quadlet/systemd or `podman kube play` show up as *standalone*. Status, logs, terminal and start/stop work; there are no files to edit.
- **Files missing:** if a project's folder was moved or deleted, the stack is marked *(files missing)*. Its containers can still be stopped and inspected, but it can't be redeployed.
- **SelfCluster's own stack** is listed too, but Deploy and Down are off for it. Recreating its own container from inside would stop it halfway, so update it on the host with `docker compose up -d`.
- **Paths inside SelfCluster's container:** a stack whose folder is at `/app`, `/data`, `/usr`, `/etc`, `/var`, `/tmp` and similar collides with paths inside the container. SelfCluster can show its files but refuses to run compose for it.
- **Rootless Podman** can only write files your user owns.

### Users and single sign-on

SelfCluster doesn't keep its own user list. There are two ways in:

- **The admin password**, for the initial setup. **Once single sign-on is on, password sign-in is off** (see break-glass below).
- **Single sign-on with OpenID Connect:** your identity provider (Authelia, Authentik, Keycloak, Pocket ID, Zitadel, …) holds the users, passwords and 2FA. SelfCluster maps its groups (or individual users) to a role.

#### Shared settings

The admin password (as a scrypt hash), the single sign-on settings and the session length are part of the replicated cluster config, the same on every node. Change them on any node under **Cluster → Sign-in settings** (admins only). They're encrypted with a key derived from `CLUSTER_SECRET`, in each node's data volume and between nodes. The client secret and password hash are never sent to the browser.

- **`.env` only seeds a new cluster.** On first start, if the cluster has no sign-in settings yet, the node uses `ADMIN_PASSWORD` / `OIDC_*` / `SESSION_HOURS` from its `.env`. After that the cluster's values win. A node whose `.env` disagrees logs a warning, and the cluster and settings pages name the node and the setting.
- **No overwriting each other.** A save is first checked with every reachable node ("are you still at the version I started from?"), and the setting is briefly held on each of them. If any node already has a newer version, the save is refused and the form reloads with the latest values. The same applies to `shared.env`.
- **Changes made while nodes can't see each other** (a network split, a node offline) can't be checked that way. Each version records which versions it replaced, so when the nodes meet again SelfCluster notices two independent changes. It keeps one, using the newest version, then the later time. Nothing is dropped silently: the settings page shows a banner with **Keep …'s** / **Use …'s instead**, and the activity log records it.
- **New single sign-on settings are tested before they're saved.** **Test sign-in and save** sends you through the identity provider with the new settings. They're saved for every node only if you come back as **admin** under them. A wrong issuer, secret or group mapping fails the test and changes nothing.

#### Break-glass access

If the identity provider is down, or something else locks you out, set `BREAK_GLASS=true` in one node's `.env` and restart SelfCluster there (`docker compose up -d`). That node accepts the cluster's admin password again. Editing `.env` already needs root on the host, so the flag doesn't open anything a host admin couldn't do anyway.

- A break-glass sign-in is admin and lasts **1 hour**. It works on every node, like any session, including when you switch nodes.
- Turning it on is written to the activity log. While it's on, the cluster page shows a warning and a "break-glass on" badge on that node.
- When you're done, remove the line and restart again.

Keep an admin password set (Settings), or break-glass has nothing to re-enable. A node that has never received the cluster's settings falls back to `ADMIN_PASSWORD` from its own `.env`. The old `PASSWORD_LOGIN` setting is ignored now, with a warning in the log.

#### Roles

| | viewer | operator | admin |
|---|:-:|:-:|:-:|
| See servers, stacks, status, cluster page | ✓ | ✓ | ✓ |
| Read compose files and logs, container stats | ✓ | ✓ | ✓ |
| See env file values (`.env`, `shared.env`) | masked | masked | ✓ |
| Start, stop, restart, pull image | | ✓ | ✓ |
| Deploy (`compose up`), down, pull a stack; validate | | ✓ | ✓ |
| Edit compose and env files, `shared.env` | | | ✓ |
| Terminal (`docker exec`) | | | ✓ |
| New stack, deploy on another server, remove container, remove node | | | ✓ |

The admin password sign-in is always **admin**. With SSO, map groups (or users and emails) to each role in Settings, or with `OIDC_ADMIN_GROUPS`, `OIDC_OPERATOR_GROUPS`, `OIDC_VIEWER_GROUPS` (and the `*_USERS` versions) when seeding from `.env`. The highest matching role wins. Accounts that match nothing are refused, unless you pick a default role. The 0.2 names `OIDC_ALLOWED_GROUPS` / `OIDC_ALLOWED_USERS` still work in `.env` and mean admin.

The rules are enforced on the server for every request and WebSocket, both on the node you're connected to and again on the node that owns the containers. A relayed request carries the user's role inside the signed node-to-node request. The UI just hides or disables what you can't use. The terminal is admin-only because a shell in a container is usually root in it. Compose files are visible to viewers as they are, so keep secrets in `.env` files rather than inline `environment:` values. Logs aren't masked either.

To set up SSO:

1. On the identity provider, create a **confidential** OIDC client (authorization code flow; SelfCluster always uses PKCE). Add one redirect URI per address you open SelfCluster at:
   ```
   http://192.168.1.10:7443/auth/oidc/callback     ← each node's NODE_URL
   http://192.168.1.21:7443/auth/oidc/callback
   https://selfcluster.home.lan/auth/oidc/callback    ← each entry in PUBLIC_URLS
   ```
   Many providers only accept `https://` redirect URIs. In that case put SelfCluster behind your TLS reverse proxy and list that address in `PUBLIC_URLS`.
2. Sign in with the admin password, open **Cluster → Sign-in settings** and fill in the issuer, client ID, client secret, button label and role mappings (e.g. `homelab-admins` → admin, `homelab-ops` → operator, `family` → viewer). The page lists the redirect URIs to register.
3. Click **Test sign-in and save** and sign in at the provider with an account that should be admin. When you come back, the settings are saved for every node, and the sign-in page shows only **Sign in with …** from then on.

   Prefer config files? Put the same values in the first node's `.env` instead (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`, `OIDC_ADMIN_GROUPS`, …, see `.env.example`). They seed the cluster on first start. They aren't tested the way the Settings page tests them, so keep break-glass in mind.

Provider notes:

| Provider | `OIDC_ISSUER` | Groups |
|---|---|---|
| Authelia | `https://auth.example.com` | Add `groups` to the client's scopes. Authelia returns them from userinfo, which SelfCluster reads. |
| Authentik | `https://authentik.example.com/application/o/<slug>/` | Included in the `profile` scope. Set `OIDC_SCOPES=openid profile email`. |
| Keycloak | `https://kc.example.com/realms/<realm>` | Add a "Group Membership" mapper named `groups` (full path off) and set `OIDC_SCOPES=openid profile email`, or use realm roles with `OIDC_GROUPS_CLAIM=realm_access.roles`. |
| Pocket ID | `https://id.example.com` | Supports the `groups` scope (requested by default when any `*_GROUPS` role mapping is set). |

How it behaves:

- Sign-in uses the authorization code flow with PKCE, `state` and `nonce`. The ID token's signature, issuer, audience, expiry and nonce are checked against the provider's published keys. Emails count for the `*_USERS` lists only when the provider doesn't mark them unverified.
- A successful SSO sign-in gets the same session as a password sign-in: a signed cookie valid on every node for the session length in Settings (default 7 days). The role is decided at sign-in: changing someone's groups takes effect at their next sign-in, not immediately. Lower the session length if that matters to you.
- Sign out also ends the provider session when the provider supports it (`end_session_endpoint`).
- Refused sign-ins show the reason on the sign-in page and are written to the activity log.

### Floating IP (optional)

Give every node the same `VIP_ADDRESS`, `VIP_INTERFACE`, `VIP_PASSWORD` and `VIP_ROUTER_ID`, and a different `VIP_PRIORITY`. Then run:

```bash
docker compose --profile vip up -d
```

keepalived (host networking) keeps the address on the highest-priority node whose SelfCluster answers `/healthz`. Point a DNS name such as `selfcluster.home.lan` at it. If your network blocks multicast (some Wi-Fi and cloud networks do), set `VIP_UNICAST_PEERS` to the other nodes' IPs. This needs the nodes to share a layer-2 network, so a VPS outside your LAN can't take part. Reach that one through its Tailscale/WireGuard address instead.

### Podman

Rootful Podman works with `DOCKER_SOCKET=/run/podman/podman.sock`. Rootless works too: use `/run/user/<uid>/podman/podman.sock`.

## Security notes

- The Docker socket is root on that machine, and so is anyone who can sign in to SelfCluster as admin. Don't expose port 7443 to the internet.
- The container mounts the host's `/` read-write at `/host`. That doesn't add privileges (the socket can already start a container that mounts `/`), but a bug in SelfCluster could now touch host files directly. SelfCluster only writes a stack's own compose and env files, `shared.env`, and new stack folders under `STACKS_DIR`. It runs with `label=disable` so this works on SELinux hosts.
- Node traffic is signed but **not encrypted**. On a LAN that you trust this is usually acceptable. For nodes outside it (for example a VPS), run the cluster over Tailscale or WireGuard and use those addresses in `NODE_URL` and `PEERS`, or put a TLS reverse proxy in front and use `https://` URLs.
- `CLUSTER_SECRET` lets anyone who has it act as a node. Keep `.env` private (`chmod 600 .env`).
- Password sign-in is one admin account (`ADMIN_USER` / `ADMIN_PASSWORD`); failed attempts are rate-limited per IP. With SSO, users and 2FA live in your identity provider, and its groups decide each person's role (viewer, operator, admin).
- Sessions can't be revoked one by one. Changing `CLUSTER_SECRET` on all nodes signs everyone out.
- Values in read-backs of standalone containers that look like secrets are masked. `.env` files are shown as they are.

## Data

Each node keeps this in the `selfcluster-data` volume:

| File | What |
|---|---|
| `cluster.json` | replicated config (node list, shared.env) |
| `cache/<node>.json` | last snapshot of each peer |
| `history/<stack>/` | the last 20 versions of each file SelfCluster overwrote |
| `audit.jsonl` | this node's activity log |
| `file-meta.json` | who saved each file last |
| `projects.json` | compose projects this node has seen: name, folder, compose files, env files |

## Limitations

- Logs and the terminal need the node to be online; cached copies cover inventory and files only.
- "Deploy on another server" copies compose and env files, not volume data or bind-mounted folders.
- A node removed with "Remove from cluster" rejoins if SelfCluster starts on it again with the same `CLUSTER_SECRET`.
- Two people saving `shared.env` on two nodes within the same heartbeat: the later one wins, the earlier change is lost (single-node files are protected by the conflict check).

## Development

```bash
npm install
CLUSTER_SECRET=dev-secret-0123456789 ADMIN_PASSWORD=dev NODE_ID=dev \
  STACKS_DIR=$PWD/.testdata/stacks DATA_DIR=$PWD/.testdata/data \
  DOCKER_SOCKET_IN_CONTAINER=/var/run/docker.sock npm start
```

`server/` is plain Node.js (Express, ws, dockerode). `public/` is the UI, plain HTML/CSS/JS with xterm.js. There is no build step.

## License

MIT. See [LICENSE](LICENSE).
