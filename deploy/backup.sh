#!/usr/bin/env bash
#
# Daily backup of the word database (stats, custom words, reports) to the
# volume, keeping the last 14. Uses SQLite's online backup, so it is safe
# while the game is running. Install once with:
#
#   (crontab -l 2>/dev/null; echo "30 3 * * * /opt/vmock-skribble/vckscribble-be/deploy/backup.sh >> /var/log/vmock-backup.log 2>&1") | crontab -
#
# Copy a backup off the server:
#   docker compose -f /opt/vmock-skribble/vckscribble-be/deploy/docker-compose.yml \
#     cp backend:/data/backups/<file>.db ./
set -euo pipefail
cd "$(dirname "$0")"

docker compose exec -T backend node -e "
  const fs = require('node:fs');
  const Database = require('better-sqlite3');
  fs.mkdirSync('/data/backups', { recursive: true });
  const name = '/data/backups/game-' + new Date().toISOString().slice(0, 10) + '.db';
  new Database('/data/game.db', { readonly: true }).backup(name)
    .then(() => {
      const old = fs.readdirSync('/data/backups').filter((f) => f.endsWith('.db')).sort().slice(0, -14);
      for (const f of old) fs.unlinkSync('/data/backups/' + f);
      console.log(new Date().toISOString(), 'backup ok:', name, '(pruned', old.length + ')');
    })
    .catch((e) => { console.error('backup failed', e); process.exit(1); });
"
