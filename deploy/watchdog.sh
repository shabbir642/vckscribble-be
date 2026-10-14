#!/usr/bin/env bash
#
# Self-healing, from inside the server, every minute. Docker already restarts
# a container that crashes; this catches the ones that are running but stuck
# (a hung event loop, Caddy wedged), which Docker leaves alone. The external
# check (.github/workflows/uptime.yml) is what tells people; this one fixes.
#
# Three failed checks in a row restart the stack, at most once per 10 minutes
# so a deeper problem cannot become a restart loop. It also frees disk space
# when old images pile up. Install once with:
#
#   (crontab -l 2>/dev/null; echo "* * * * * /opt/vmock-skribble/vckscribble-be/deploy/watchdog.sh >> /var/log/vmock-watchdog.log 2>&1") | crontab -
set -uo pipefail
cd "$(dirname "$0")"

STATE=/var/lib/vmock-watchdog
FAILS_BEFORE_RESTART=3
RESTART_COOLDOWN_S=600
mkdir -p "$STATE"
log() { echo "$(date -u '+%F %T') $*"; }

# Through Caddy, the way players reach it, but without leaving the machine.
DOMAIN=$(sed -n 's/^DOMAIN=//p' .env | cut -d, -f1 | tr -d ' "')
healthy() {
  curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null \
    | grep -q '"ok":true'
}

# Disk: image rebuilds leave old layers behind.
used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
if [ "${used:-0}" -ge 85 ]; then
  log "disk ${used}% full, pruning unused images"
  docker image prune -af --filter 'until=72h' >/dev/null
  docker builder prune -af --filter 'until=72h' >/dev/null
fi

if healthy; then
  if [ -s "$STATE/fails" ]; then log "healthy again"; fi
  : > "$STATE/fails"
  exit 0
fi

fails=$(( $(cat "$STATE/fails" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE/fails"
log "health check failed ($fails in a row)"
[ "$fails" -lt "$FAILS_BEFORE_RESTART" ] && exit 0

last=$(cat "$STATE/last_restart" 2>/dev/null || echo 0)
if [ $(( $(date +%s) - last )) -lt "$RESTART_COOLDOWN_S" ]; then
  log "still failing after a restart; leaving it for a human (docker compose ps / logs)"
  exit 0
fi

date +%s > "$STATE/last_restart"
log "restarting the stack"
docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' | sed 's/^/  before: /'
# Starts anything that stopped, then restarts what is running but stuck.
# The backend saves its rooms on the way down, so games resume.
docker compose up -d
docker compose restart
sleep 20
if healthy; then log "recovered after restart"; : > "$STATE/fails"; else log "still unhealthy after restart"; fi
