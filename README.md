# vckscribble-be

Backend for **Drawdle** — a corporate-slang drawing-and-guessing game.
Node + Express + Socket.IO + SQLite (Drizzle).

Frontend lives in [`vckscribble-fe`](https://github.com/shabbir642/vckscribble-fe).
Plan and architecture: [`vckscribble`](https://github.com/shabbir642/vckscribble).

## Run

```bash
pnpm install
cp .env.example .env
pnpm dev            # :3001
```

The dictionary seeds itself on boot. `GET /api/health` reports the enabled word
count and contract version.

## The contract

`src/contract/index.ts` is the **single source of truth** for the socket
protocol, shared domain types, and the guess-normalization logic. The FE repo
vendors a copy and its CI fails if the two diverge.

Change the protocol here, then run `pnpm contract:sync` in the FE repo and
commit the regenerated file.

## Word management

No admin UI by design — the dictionary is a table, so SQL is the interface.

```bash
sqlite3 data/game.db
```

```sql
-- add
INSERT INTO words (text, normalized, category, drawability, source)
VALUES ('circle back', 'circle back', 'meeting', 2, 'owner');

-- what are players inventing?
SELECT text, times_used FROM suggestions ORDER BY times_used DESC;

-- promote player words
INSERT OR IGNORE INTO words (text, normalized, category, drawability, source)
SELECT text, normalized, 'player', 2, 'player' FROM suggestions WHERE id IN (1,2);

-- retire what nobody guesses
SELECT text, times_drawn, times_guessed,
       ROUND(100.0 * times_guessed / times_drawn) AS guess_pct
FROM words WHERE times_drawn >= 10 ORDER BY guess_pct ASC;
```

### `POST /api/words`

A convenience over the SQL above, for adding words without shell access to the
volume. Disabled unless `WORDS_API_TOKEN` is set — an unconfigured deploy fails
closed rather than exposing a public write endpoint.

```bash
curl -X POST https://your-app.fly.dev/api/words \
  -H "authorization: Bearer $WORDS_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"words":[{"text":"shiny object syndrome","category":"idiom","drawability":1}]}'
# -> {"ok":true,"inserted":1,"skipped":0,"received":1}
```

Idempotent on the normalized text, so re-posting the same list is safe.

Bulk additions belong in `src/db/words.seed.ts` instead — version-controlled,
reviewable in diffs, and re-seeding never overwrites rows you edited by hand.

## Storage

The 235-word dictionary is seeded from `src/db/words.seed.ts` at every boot
(idempotent, never overwriting rows you edited), so a fresh database file is
always a playable game.

In the VPS deployment the file lives on the `game-data` Docker volume, so word
statistics, words added through `POST /api/words`, player-invented words and
reports all survive restarts and redeploys — the curation queries above work
on real history.

Rooms live in memory while the server runs, but a graceful stop (SIGTERM —
what `docker compose up` sends when it replaces the container) writes every
room to the `room_snapshots` table first, and the next boot restores them with
every deadline shifted by the downtime. Players' clients reconnect and resume
on their own: a deploy mid-game is a pause of a few seconds. A hard crash
(`kill -9`, power loss) skips the shutdown hook, so those games are lost.

better-sqlite3 must stay on 13+: 11.x and 12.x crash on Node 24.19+ when a
prepared statement is garbage-collected (nodejs/node#65446).

Inspect it on the server with:

```bash
docker compose -f deploy/docker-compose.yml exec backend \
  node -e "const db=require('better-sqlite3')('/data/game.db');console.table(db.prepare('SELECT text,times_drawn,times_guessed,reported FROM words ORDER BY times_drawn DESC LIMIT 20').all())"
```

## When something breaks

Nothing is tracked and nothing is stored — this is a game, not a product.
Browser-side failures do get printed to the server log, because they are
otherwise completely invisible: a connection that never establishes leaves the
backend log clean while every player stares at a broken page.

```
[client] socket from Ann@VWW3: connect_error: xhr poll error
```

They arrive over the socket when one is open, and over `POST /api/client-log`
when none is — which is the case worth catching. Both are rate limited.

A React render error is caught by an error boundary on the frontend, so a crash
shows a message and a reload button rather than a white page.

## Deploy (VPS)

One Docker Compose stack in `deploy/`: Caddy terminates HTTPS (automatic
Let's Encrypt), serves the frontend, and proxies `/api` and `/socket.io` to the
backend. Everything is one origin, so there is no CORS to configure and no
backend URL baked into the frontend build.

Any Linux VPS with Docker works. The backend is a single Node process, so
**one fast dedicated vCPU and 1 GB RAM** comfortably covers hundreds of
concurrent players (see Capacity); extra cores only help Caddy.

```bash
# on the server, both repos side by side
git clone https://github.com/shabbir642/vckscribble-be
git clone https://github.com/shabbir642/vckscribble-fe
cd vckscribble-be/deploy
cp .env.example .env        # set DOMAIN and CLIENT_ORIGIN
docker compose up -d --build
docker compose logs -f backend
```

Before the first start: point the domain's DNS A record at the server and open
ports 80 and 443 (e.g. `ufw allow 80,443/tcp && ufw allow 443/udp`). Without a
domain yet, set `DOMAIN=:80` and `CLIENT_ORIGIN=http://<server-ip>`.

**Updating:** `git pull` in both repos, then `docker compose up -d --build`.
Games in progress pause for the few seconds the swap takes and then carry on
(see Storage). Keep `stop_grace_period` long enough for the save to finish.

Rooms are held in memory, so a second backend process would not see the
first's rooms — scale up (a faster CPU), not out.

## Capacity

The stroke path sends only new points, as quantized integers, so the cost per
message is independent of stroke length. Measured locally (Apple Silicon, one
core, production build) with every room drawing continuously:

| Concurrent users | Rooms | Stroke latency p50 / p99 | Server CPU | Heap |
|---|---|---|---|---|
| 480 | 60 | 3.8 ms / 10 ms | ~17% of a core | 61 MB |
| 1200 | 150 | 3.2 ms / 15 ms | ~45% of a core | 88 MB |

`GET /api/health` reports live `sockets`, `rooms`, `heapMb` and event-loop lag
(`loopLagMs`) — the number to watch, since every room shares one event loop.

Per-IP allowances are sized for an office behind one NAT address (1000
sockets, 400-join burst). Raise them for bigger events with
`IP_LIMIT_SCALE=<n>`.

## Scripts

| | |
|---|---|
| `pnpm dev` | watch mode |
| `pnpm build` / `pnpm start` | compile / run compiled |
| `pnpm typecheck` | tsc --noEmit |
| `pnpm db:seed` | seed dictionary (idempotent) |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm smoke` | room lifecycle and drawing (37 cases, needs a running server) |
| `pnpm smoke:game` | round machine (22 cases) |
| `pnpm smoke:guess` | guessing & scoring (13 cases) |
| `pnpm smoke:spelling` | spaces, capitals and punctuation in a guess don't count; a near miss is still "close" (27 cases) |
| `pnpm smoke:summary` | end-of-game summary: a whole game, re-sends to late arrivals, play again, kicks, the final scoreboard (63 cases, ~30 s) |
| `pnpm smoke:teams` | team games: teams in the lobby, whose turn it is, who guesses and who is told the word, scoring, leaving and arriving mid-game, the results, an old snapshot restored; a room of 30; what changed for everyone-for-themselves rooms (145 cases, ~45 s) |
