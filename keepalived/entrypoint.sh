#!/bin/sh
# Generates a keepalived config that holds VIP_ADDRESS on the healthiest, highest-priority node.
# The address only stays on a node while its SelfCluster answers /healthz.
set -eu

: "${VIP_ADDRESS:?Set VIP_ADDRESS in .env, for example 192.168.1.5/24}"
IFACE="${VIP_INTERFACE:-eth0}"
PRIORITY="${VIP_PRIORITY:-100}"
ROUTER_ID="${VIP_ROUTER_ID:-51}"
PASS="$(printf '%s' "${VIP_PASSWORD:-selfcluster}" | cut -c1-8)"
PORT="${PORT:-7443}"

mkdir -p /etc/keepalived
cat > /etc/keepalived/check-selfcluster.sh <<CHECK
#!/bin/sh
wget -q -T 2 -O /dev/null "http://127.0.0.1:${PORT}/healthz"
CHECK
chmod 755 /etc/keepalived/check-selfcluster.sh

UNICAST=""
if [ -n "${VIP_UNICAST_PEERS:-}" ]; then
  UNICAST="  unicast_peer {"
  for ip in ${VIP_UNICAST_PEERS}; do UNICAST="${UNICAST}
    ${ip}"; done
  UNICAST="${UNICAST}
  }"
fi

cat > /etc/keepalived/keepalived.conf <<CONF
global_defs {
  script_user root
  enable_script_security
}

vrrp_script chk_selfcluster {
  script "/etc/keepalived/check-selfcluster.sh"
  interval 2
  fall 2
  rise 2
}

vrrp_instance SELFCLUSTER {
  state BACKUP
  interface ${IFACE}
  virtual_router_id ${ROUTER_ID}
  priority ${PRIORITY}
  advert_int 1
  authentication {
    auth_type PASS
    auth_pass ${PASS}
  }
${UNICAST}
  virtual_ipaddress {
    ${VIP_ADDRESS}
  }
  track_script {
    chk_selfcluster
  }
}
CONF

echo "[selfcluster-vip] ${VIP_ADDRESS} on ${IFACE}, priority ${PRIORITY}, router id ${ROUTER_ID}"
exec keepalived --dont-fork --log-console --log-detail --use-file /etc/keepalived/keepalived.conf
