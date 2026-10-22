#!/usr/bin/env bash
#
# Keeps the website Cloudflare-only once the site is behind it: an attack on
# the site that skips Cloudflare by aiming at the server's own address gets
# nothing from Caddy. SSH is left alone.
#
# Port 443 itself is open to everyone. The game's own names (GAME_HOST and
# EXTRA_GAME_HOSTS, e.g. play.<site>, DNS only) use it for players whose
# network blocks the direct game port, so they still reach this server
# straight rather than through Cloudflare, which can add hundreds of
# milliseconds (from India it may answer from Singapore). Caddy tells the two
# apart: the website answers only the addresses in SITE_ONLY_FROM
# (deploy/.env), which this script sets to Cloudflare's current ranges, and
# the game's endpoints answer anyone. Port 80 (Let's Encrypt) and the direct
# game ports stay open too.
#
#   cloudflare-firewall.sh          show what it would do
#   cloudflare-firewall.sh apply    website from Cloudflare's current ranges only
#   cloudflare-firewall.sh undo     website from anyone again
#
# `apply` refuses while any site name in DOMAIN (the game's direct names
# aside) still resolves to something other than Cloudflare: players reaching
# the site directly would be cut off.
# Safe to rerun; monthly from cron keeps the ranges current, restarting the
# web server only when they change:
#
#   (crontab -l 2>/dev/null; echo "17 4 1 * * /opt/vmock-skribble/vckscribble-be/deploy/cloudflare-firewall.sh apply >> /var/log/vmock-firewall.log 2>&1") | crontab -
set -euo pipefail
cd "$(dirname "$0")"
# cron's PATH has no sbin, where ufw lives.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

TAG=cloudflare
mode=${1:-check}
log() { echo "$(date -u '+%F %T') $*"; }

# Until October 2026 port 443 was shut at the firewall to all but Cloudflare,
# one rule per range (tagged "cloudflare"). Those go, and it opens to everyone.
open_443() {
  ufw status numbered | sed -n "s/^\[ *\([0-9]*\)\].*# $TAG\$/\1/p" | sort -rn |
    while read -r n; do ufw --force delete "$n" >/dev/null; done
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null # HTTP/3
}

current() { sed -n 's/^SITE_ONLY_FROM=//p' .env | tr -d '"'; }
# What the running web server was started with, and what it would be started
# with now (.env, else docker-compose.yml's default): they differ after a hand
# edit or an interrupted run.
running() { docker compose exec -T web printenv SITE_ONLY_FROM 2>/dev/null || true; }
configured() { docker compose config --format json 2>/dev/null | jq -r '.services.web.environment.SITE_ONLY_FROM // ""'; }

set_site_only_from() { # value; empty removes the line
  local tmp
  tmp=$(mktemp)
  cp -p .env .env.bak-firewall # .env holds every secret: never lose it to a failed write
  grep -v '^SITE_ONLY_FROM=' .env > "$tmp" || true
  [ -z "$1" ] || echo "SITE_ONLY_FROM=\"$1\"" >> "$tmp"
  cat "$tmp" > .env || { cp -p .env.bak-firewall .env; rm -f "$tmp"; log "could not write .env; left as it was"; exit 1; }
  rm -f "$tmp" # written in place: .env keeps its owner and mode
}

# The first site name (the game's own aside), to check the site answers.
site_name() {
  local direct names
  direct=" $({ grep -E '^(GAME_HOST|EXTRA_GAME_HOSTS)=' .env || true; } | cut -d= -f2- | tr -d ' "' | tr ',\n' '  ') "
  names=$(sed -n 's/^DOMAIN=//p' .env | tr -d ' "' | tr ',' ' ')
  for name in $names; do
    case "$direct" in *" $name "*) continue ;; esac
    echo "$name"
    return
  done
}

# Recreates the web container so Caddy reads SITE_ONLY_FROM, then checks the
# site still answers: this server's own health check (as autodeploy.sh does),
# and a page fetched through Cloudflare from here (a query string the edge
# has never seen, so the request really reaches Caddy from Cloudflare).
restart_web() {
  docker compose up -d --no-deps web >/dev/null 2>&1 || return 1
  local name i up=
  name=$(site_name)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    curl -fsS -o /dev/null --max-time 5 --resolve "$name:443:127.0.0.1" "https://$name/" 2>/dev/null && { up=1; break; }
  done
  [ -n "$up" ] || return 1
  [ "$(running)" = "$(configured)" ] || return 1 # the new value must be the one in use
  [ -n "$(current)" ] || return 0 # open to everyone: nothing more to prove
  curl -fsS -o /dev/null --max-time 20 "https://$name/?origin-check=$(date +%s)$RANDOM" 2>/dev/null
}

# Not while a deploy is rebuilding the same containers.
mkdir -p /var/lib/vmock-deploy
exec 9>/var/lib/vmock-deploy/lock
flock -w 900 9 || { log "a deploy has held the lock for 15 minutes; nothing changed"; exit 1; }

if [ "$mode" = undo ]; then
  [ -z "$(current)" ] || set_site_only_from ""
  if [ "$(running)" != "$(configured)" ]; then
    restart_web || { log "the web server did not come back: check 'docker compose ps'"; exit 1; }
  fi
  open_443
  log "the website answers everyone again"
  exit 0
fi

v4=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v4)
v6=$(curl -fsS --max-time 15 https://www.cloudflare.com/ips-v6)
ranges=$(printf '%s\n%s\n' "$v4" "$v6" | grep -E '^[0-9a-f.:]+/[0-9]+$' || true)
# A truncated download must not shrink the allow-list to almost nothing.
[ "$(echo "$ranges" | wc -l)" -ge 15 ] || { log "could not fetch Cloudflare's ranges; nothing changed"; exit 1; }

in_cloudflare() { # ip
  python3 - "$1" $ranges <<'EOF'
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
sys.exit(0 if any(ip in ipaddress.ip_network(r) for r in sys.argv[2:]) else 1)
EOF
}

direct=" $({ grep -E '^(GAME_HOST|EXTRA_GAME_HOSTS)=' .env || true; } | cut -d= -f2- | tr -d ' "' | tr ',\n' '  ') "
names=$(sed -n 's/^DOMAIN=//p' .env | tr -d ' "' | tr ',' ' ')
ready=1
for name in $names; do
  case "$direct" in *" $name "*) log "$name: the game's direct name, stays off Cloudflare"; continue ;; esac
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
[ "$ready" = 1 ] || { log "refusing: some names still reach the server directly; nothing changed"; exit 1; }

want=$(echo $ranges) # one line, space-separated
before=$(current)
if [ "$before" = "$want" ] && [ "$(running)" = "$want" ]; then
  log "website already answers Cloudflare only ($(echo "$ranges" | wc -l) ranges, unchanged)"
else
  set_site_only_from "$want"
  if ! restart_web; then
    # Never leave the site down: back to what it was, or open to everyone.
    [ "$before" != "$want" ] || before=""
    set_site_only_from "$before"
    restart_web || true
    log "the site stopped answering with the new ranges; put back as it was"
    exit 1
  fi
  log "website now answers Cloudflare only ($(echo "$ranges" | wc -l) ranges)"
fi
# Only now, with the website guarded by Caddy: 443 open for the game's names.
open_443
log "port 443 open to everyone for the game's own names; 80 and the game ports stay open"
