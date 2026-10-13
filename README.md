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

## Finding out what hurts

Every meaningful thing that happens is appended to an `events` table in the same
SQLite file as the dictionary, so you can see where the game is frustrating
people without waiting for anyone to say so. Rows are facts, never updated, and
pruned after 30 days (`EVENT_RETENTION_DAYS`).

Types: `room_created`, `player_joined`, `player_reclaimed_seat`,
`player_reconnected`, `player_dropped`, `game_started`, `turn_started`,
`turn_ended`, `custom_word`, `word_reported`, `game_finished`, `client_error`.
`data` is JSON whose shape depends on the type.

`/api/health` carries a 24-hour count per type, which is enough to tell at a
glance whether anything is happening and whether clients are erroring.

### The queries worth running

**Words nobody can guess** — the drawability rating is wrong, or the phrase is
undrawable. This is the main feedback loop for the dictionary:

```sql
SELECT json_extract(data, '$.word') AS word,
       COUNT(*) AS turns,
       SUM(json_extract(data, '$.solved') = 0) AS nobody_got_it,
       ROUND(AVG(json_extract(data, '$.solved') * 1.0 /
                 MAX(json_extract(data, '$.guessers'), 1)), 2) AS solve_rate
FROM events WHERE type = 'turn_ended'
GROUP BY word HAVING turns >= 3
ORDER BY solve_rate ASC, turns DESC LIMIT 20;
```

Retire the bad ones with `UPDATE words SET enabled = 0 WHERE text = '...'`, or
correct the rating rather than dropping the word:
`UPDATE words SET drawability = 3 WHERE text = '...'`.

**Games dying early** — people leaving mid-game rather than finishing:

```sql
SELECT json_extract(data, '$.reason') AS reason, COUNT(*) AS games,
       ROUND(AVG(json_extract(data, '$.roundsPlayed')), 1) AS avg_rounds
FROM events WHERE type = 'game_finished' GROUP BY reason;
```

**Are people losing their session?** A `player_reclaimed_seat` means someone came
back without their token. A rising share here is a client-side storage problem,
not people choosing to leave:

```sql
SELECT type, COUNT(*) FROM events
WHERE type IN ('player_joined', 'player_reclaimed_seat', 'player_reconnected', 'player_dropped')
  AND at > unixepoch() - 86400 * 7
GROUP BY type;
```

**Is the custom-word filter in the way?**

```sql
SELECT json_extract(data, '$.reason') AS rejected_because, COUNT(*) AS n
FROM events WHERE type = 'custom_word' AND json_extract(data, '$.accepted') = 0
GROUP BY rejected_because ORDER BY n DESC;
```

**Broken clients** — anything here is a player seeing something you are not:

```sql
SELECT json_extract(data, '$.source') AS source,
       json_extract(data, '$.message') AS message,
       COUNT(*) AS n, MAX(datetime(at, 'unixepoch')) AS last_seen
FROM events WHERE type = 'client_error'
GROUP BY source, message ORDER BY n DESC LIMIT 20;
```

A client error arrives by socket when one is open, and by `POST /api/client-log`
when none is — the beacon exists because the failures that stop a socket
connecting are exactly the ones the server cannot otherwise see. A CORS
misconfiguration once took the game down completely while the backend log stayed
clean.

**Reported words** awaiting a decision:

```sql
SELECT json_extract(data, '$.word') AS word, player_name AS reported_by,
       datetime(at, 'unixepoch') AS when_
FROM events WHERE type = 'word_reported' ORDER BY at DESC;
```

### A note on what is stored

Player names are recorded alongside ids, so the rows read like a story rather
than a hash join. They are user-supplied text: treat the table as containing
whatever people typed, and do not paste it somewhere public without a look.

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
