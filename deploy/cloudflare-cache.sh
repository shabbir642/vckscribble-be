#!/usr/bin/env bash
#
# Pages served from Cloudflare's edge, near the player, instead of a round
# trip to this server for every visit. The Caddyfile marks pages
# (Cloudflare-CDN-Cache-Control: a day); this sets up the zone side and
# clears the copies when a deploy changes them.
#
#   cloudflare-cache.sh setup   add the cache rule to every site's zone (once)
#   cloudflare-cache.sh purge   drop every cached copy (autodeploy.sh, after each deploy)
#   cloudflare-cache.sh check   show whether pages are coming from the edge
#
# Needs CF_API_TOKEN in .env: a Cloudflare API token limited to the site
# zones, with Zone Read, Cache Purge and Cache Rules Edit. Without it, purge
# does nothing (so deploys work as before) and setup refuses.
set -euo pipefail
cd "$(dirname "$0")"

RULE="drawdle: pages from the edge"
mode=${1:-check}
log() { echo "$(date -u '+%F %T') [cache] $*"; }

names=$(sed -n 's/^DOMAIN=//p' .env | tr -d ' "' | tr ',' ' ')
token=$(sed -n 's/^CF_API_TOKEN=//p' .env | tr -d ' "')
# The zones: each site name without its www.
zones=$(for n in $names; do echo "${n#www.}"; done | awk -F. '{print $(NF-1)"."$NF}' | sort -u)

if [ "$mode" = check ]; then
  for n in $names; do
    for try in 1 2; do
      s=$(curl -sS -o /dev/null -D - "https://$n/" | tr -d '\r' | sed -n 's/^cf-cache-status: //Ip')
      echo "$n (request $try): ${s:-no Cloudflare header}"
    done
  done
  exit 0
fi

if [ -z "$token" ]; then
  [ "$mode" = purge ] && exit 0
  log "CF_API_TOKEN is not set in .env"; exit 1
fi
api() { # method path [json]
  curl -fsS --max-time 20 -X "$1" "https://api.cloudflare.com/client/v4$2" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' ${3:+--data "$3"}
}
zone_id() { api GET "/zones?name=$1" | jq -r '.result[0].id // empty'; }

case "$mode" in
  purge)
    for z in $zones; do
      id=$(zone_id "$z") || id=
      if [ -n "$id" ] && api POST "/zones/$id/purge_cache" '{"purge_everything":true}' >/dev/null; then
        log "$z: cleared"
      else
        log "$z: could not clear the cache (token or zone?)"
      fi
    done
    ;;
  setup)
    # Only the site names (not play.*, which bypass Cloudflare), and never the
    # game's own traffic: the API and Socket.IO (polling is plain GETs).
    hosts=$(for n in $names; do printf '"%s" ' "$n"; done)
    expr="(http.host in {${hosts% }} and not starts_with(http.request.uri.path, \"/api/\") and not starts_with(http.request.uri.path, \"/socket.io/\") and not starts_with(http.request.uri.path, \"/s/\"))"
    rule=$(jq -n --arg d "$RULE" --arg e "$expr" '{
      description: $d, expression: $e, action: "set_cache_settings",
      action_parameters: { cache: true, edge_ttl: { mode: "respect_origin" }, browser_ttl: { mode: "respect_origin" } } }')
    for z in $zones; do
      id=$(zone_id "$z")
      [ -n "$id" ] || { log "$z: zone not found with this token"; exit 1; }
      phase="/zones/$id/rulesets/phases/http_request_cache_settings/entrypoint"
      # Keep any cache rules made in the dashboard; replace only ours.
      current=$(api GET "$phase" 2>/dev/null | jq '[.result.rules // [] | .[] | select(.description != "'"$RULE"'") | {description, expression, action, action_parameters, enabled}]' || echo '[]')
      body=$(jq -n --argjson keep "$current" --argjson ours "$rule" '{rules: ($keep + [$ours])}')
      api PUT "$phase" "$body" >/dev/null
      log "$z: cache rule in place"
    done
    "$0" purge
    ;;
  *) echo "usage: $0 setup|purge|check"; exit 2 ;;
esac
