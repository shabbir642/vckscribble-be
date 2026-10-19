#!/usr/bin/env bash
#
# Lets web and game traffic in only from Cloudflare, once the site is behind
# it: a flood aimed at the server's own address is then dropped here instead
# of reaching Caddy or the game. SSH is left alone.
#
#   cloudflare-firewall.sh          show what it would do
#   cloudflare-firewall.sh apply    allow 80, 443 and the direct game ports
#                                   from Cloudflare's current ranges only
#   cloudflare-firewall.sh undo     open them to everyone again
#
# `apply` refuses while any name in DOMAIN still resolves to something other
# than Cloudflare: players reaching the server directly would be cut off.
# Safe to rerun; monthly from cron keeps the ranges current:
#
#   (crontab -l 2>/dev/null; echo "17 4 1 * * /opt/vmock-skribble/vckscribble-be/deploy/cloudflare-firewall.sh apply >> /var/log/vmock-firewall.log 2>&1") | crontab -
set -euo pipefail
cd "$(dirname "$0")"

TAG=cloudflare
PORTS=80,443,8443:8458
mode=${1:-check}
log() { echo "$(date -u '+%F %T') $*"; }

# Rules this script added, deleted last-first so the numbers stay valid.
remove_ours() {
  ufw status numbered | sed -n "s/^\[ *\([0-9]*\)\].*# $TAG\$/\1/p" | sort -rn |
    while read -r n; do ufw --force delete "$n" >/dev/null; done
}
# The setup script's open-to-everyone rules.
open_rules() { echo "80/tcp 443/tcp 443/udp 8443:8458/tcp"; }

if [ "$mode" = undo ]; then
  remove_ours
  for r in $(open_rules); do ufw allow "$r" >/dev/null; done
  log "web and game ports open to everyone again"
  exit 0
fi

v4=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6)
ranges=$(printf '%s\n%s\n' "$v4" "$v6" | grep -E '^[0-9a-f.:]+/[0-9]+$' || true)
# A truncated download must not shrink the allow-list to almost nothing.
[ "$(echo "$ranges" | wc -l)" -ge 15 ] || { log "could not fetch Cloudflare's ranges; firewall unchanged"; exit 1; }

in_cloudflare() { # ip
  python3 - "$1" $ranges <<'EOF'
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
sys.exit(0 if any(ip in ipaddress.ip_network(r) for r in sys.argv[2:]) else 1)
EOF
}

names=$(sed -n 's/^DOMAIN=//p' .env | tr -d ' "' | tr ',' ' ')
ready=1
for name in $names; do
  addrs=$(getent ahosts "$name" | awk '{print $1}' | sort -u || true)
  [ -n "$addrs" ] || { log "$name does not resolve"; ready=0; continue; }
  for a in $addrs; do
    if in_cloudflare "$a"; then log "$name -> $a (Cloudflare)"; else log "$name -> $a (NOT Cloudflare)"; ready=0; fi
  done
done

if [ "$mode" != apply ]; then
  [ "$ready" = 1 ] && log "ready: run with 'apply'" || log "not ready: turn on the proxy (orange cloud) for every name above first"
  exit 0
fi
[ "$ready" = 1 ] || { log "refusing: some names still reach the server directly; firewall unchanged"; exit 1; }

remove_ours
for r in $ranges; do
  ufw allow proto tcp from "$r" to any port "$PORTS" comment "$TAG" >/dev/null
done
for r in $(open_rules); do ufw --force delete allow "$r" >/dev/null 2>&1 || true; done
log "web and game ports now accept Cloudflare only ($(echo "$ranges" | wc -l) ranges)"
