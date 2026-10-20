#!/usr/bin/env bash
#
# Deploys whatever is on main, once it is safe to, every minute from cron.
# The server pulls (with its read-only deploy keys) rather than GitHub pushing
# in, so no key to this server is stored anywhere else.
#
# A new commit on either repo is deployed only when:
#   - its CI on GitHub has finished and passed (a red build never ships), and
#   - both repos agree on the protocol (CONTRACT_VERSION), so a backend change
#     pushed a minute before its frontend half waits for it instead of
#     serving players a mismatched pair.
# If the new build fails or comes up unhealthy, it rolls back to the commits
# that were running before and does not retry those commits again.
#
# Install once with:
#   (crontab -l 2>/dev/null; echo "* * * * * /opt/vmock-skribble/vckscribble-be/deploy/autodeploy.sh >> /var/log/vmock-deploy.log 2>&1") | crontab -
set -uo pipefail

# Everything runs inside main(): this script is itself part of what gets
# pulled, and bash reads a script as it goes — a function is read in full
# before it runs, so updating the file mid-deploy cannot derail it.
main() {
APP=/opt/vmock-skribble
BE=$APP/vckscribble-be
FE=$APP/vckscribble-fe
STATE=/var/lib/vmock-deploy
mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || exit 0 # a deploy is still running
log() { echo "$(date -u '+%F %T') $*"; }
# Logs a waiting reason once, not every minute.
note() { [ "$(cat "$STATE/last_note" 2>/dev/null)" = "$*" ] || { log "$*"; echo "$*" > "$STATE/last_note"; }; }

git -C "$BE" fetch -q origin main || { note "fetch failed (backend)"; exit 0; }
git -C "$FE" fetch -q origin main || { note "fetch failed (frontend)"; exit 0; }
be_new=$(git -C "$BE" rev-parse origin/main)
fe_new=$(git -C "$FE" rev-parse origin/main)
be_old=$(git -C "$BE" rev-parse HEAD)
fe_old=$(git -C "$FE" rev-parse HEAD)
target="$be_new $fe_new"

[ "$be_new" = "$be_old" ] && [ "$fe_new" = "$fe_old" ] && exit 0
if grep -qxF "$target" "$STATE/failed" 2>/dev/null; then exit 0; fi

# CI: every check run on the commit finished, none failed. A commit with no
# checks at all after 15 minutes (CI skipped or not set up) goes ahead.
ci() { # repo sha dir -> prints pass | wait | fail
  local json age
  json=$(curl -fsS --max-time 15 "https://api.github.com/repos/$1/commits/$2/check-runs?per_page=100") || { echo wait; return; }
  age=$(( $(date +%s) - $(git -C "$3" log -1 --format=%ct "$2") ))
  jq -r --argjson age "$age" '
    .check_runs as $r
    | if ($r | length) == 0 then (if $age > 900 then "pass" else "wait" end)
      elif any($r[]; .status != "completed") then "wait"
      elif all($r[]; .conclusion == "success" or .conclusion == "skipped" or .conclusion == "neutral") then "pass"
      else "fail" end' <<<"$json"
}
for spec in "shabbir642/vckscribble-be $be_new $BE $be_old" "shabbir642/vckscribble-fe $fe_new $FE $fe_old"; do
  set -- $spec
  [ "$2" = "$4" ] && continue
  case "$(ci "$1" "$2" "$3")" in
    pass) ;;
    wait) note "waiting for CI on ${1#*/} ${2:0:7}"; exit 0 ;;
    *) log "CI failed on ${1#*/} ${2:0:7}; not deploying it"; echo "$target" >> "$STATE/failed"; exit 0 ;;
  esac
done

version() { git -C "$1" show "origin/main:$2" | sed -n 's/^export const CONTRACT_VERSION = \([0-9]*\);/\1/p'; }
be_v=$(version "$BE" src/contract/index.ts)
fe_v=$(version "$FE" src/generated/contract.ts)
if [ "$be_v" != "$fe_v" ]; then
  note "waiting: backend speaks contract v$be_v, frontend v$fe_v — push the other half"
  exit 0
fi

healthy() {
  local domain
  domain=$(sed -n 's/^DOMAIN=//p' "$BE/deploy/.env" | cut -d, -f1 | tr -d ' "')
  for _ in $(seq 1 12); do
    curl -fsS --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" 2>/dev/null \
      | grep -q "\"contractVersion\":$1" \
      && curl -fsS --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/" 2>/dev/null \
      | grep -q 'id="root"' && return 0
    sleep 5
  done
  return 1
}
# The Caddyfile is mounted as a single file, and git replaces rather than
# rewrites it: the running web container keeps the old one until restarted.
caddy_changed=
git -C "$BE" diff --quiet "$be_old" "$be_new" -- deploy/Caddyfile || caddy_changed=1
build() {
  (cd "$BE/deploy" && docker compose up -d --build --remove-orphans \
    && { [ -z "$caddy_changed" ] || docker compose restart web; }) > "$STATE/build.log" 2>&1
}
# Pages cached at Cloudflare's edge would outlive the deploy; drop them.
purge() { "$BE/deploy/cloudflare-cache.sh" purge || log "cache purge failed; pages may be stale for up to a day"; }

log "deploying backend ${be_old:0:7} -> ${be_new:0:7}, frontend ${fe_old:0:7} -> ${fe_new:0:7} (contract v$be_v)"
rm -f "$STATE/last_note"
git -C "$BE" reset -q --hard "$be_new"
git -C "$FE" reset -q --hard "$fe_new"
if build && healthy "$be_v"; then
  log "deployed and healthy"
  purge
  docker image prune -f >/dev/null
  exit 0
fi

log "new version failed (build log: $STATE/build.log); rolling back"
tail -20 "$STATE/build.log" | sed 's/^/  /'
echo "$target" >> "$STATE/failed"
git -C "$BE" reset -q --hard "$be_old"
git -C "$FE" reset -q --hard "$fe_old"
if build; then log "rolled back to ${be_old:0:7} / ${fe_old:0:7}"; purge; else log "ROLLBACK BUILD FAILED — check docker compose ps"; fi
}
main "$@"
exit
