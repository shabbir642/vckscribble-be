# vckscribble-be

Backend for **vckscribble** — a corporate-slang drawing-and-guessing game.
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

## Deploy

Single container; the SQLite file lives on a mounted volume, without which the
dictionary resets on every deploy.

```bash
fly launch --no-deploy       # fly.toml is committed
fly volumes create vckscribble_data --size 1
fly secrets set CLIENT_ORIGIN=https://your-frontend.example
fly secrets set WORDS_API_TOKEN="$(openssl rand -hex 24)"
fly deploy
```

Rooms are held in memory, so a second machine would not see the first's rooms:
`min_machines_running = 1` and no horizontal scaling until a shared-state
adapter (Redis) is added.

## Scripts

| | |
|---|---|
| `pnpm dev` | watch mode |
| `pnpm build` / `pnpm start` | compile / run compiled |
| `pnpm typecheck` | tsc --noEmit |
| `pnpm db:seed` | seed dictionary (idempotent) |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm smoke` | room lifecycle (29 cases, needs a running server) |
| `pnpm smoke:game` | round machine (22 cases) |
| `pnpm smoke:guess` | guessing & scoring (11 cases) |
