# Deploying vmock skribble

One VPS runs everything: Caddy (HTTPS, static frontend, reverse proxy) in front
of the Node backend, with SQLite on a Docker volume. These steps take a fresh
server to a live `https://vmock.fun` in about half an hour.

## 1. Create the server

Any provider works. What matters:

- **Region close to the players.** For a team in India: Bangalore, Mumbai or
  Delhi (DigitalOcean BLR1, Vultr Mumbai/Bangalore/Delhi, Linode Mumbai,
  AWS Lightsail Mumbai). Every stroke round-trips through the server.
- **Ubuntu 24.04 LTS.**
- **2 vCPU, 2 GB RAM.** The backend is one Node process: one fast core handles
  hundreds of players, and the second keeps Caddy and builds off its back.
  Avoid "burstable" / credit-based plans (AWS t-series, Lightsail): they slow
  to a fraction of a core under steady load.
- **Log in with an SSH key, not a password.** Paste your Mac's public key
  (`cat ~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if
  missing) when the provider asks.
- Turn on the provider's weekly backups if offered.

Note the server's **public IPv4 address**.

## 2. Point the domain at it (GoDaddy)

GoDaddy → My Products → vmock.fun → **DNS**.

1. If **Forwarding** is set up for the domain, delete it — it overrides the
   records below.
2. Edit the **A** record named **@** so it points to the server's IP
   (delete any other A records for @). TTL 600 is fine.
3. Make sure **www** is a **CNAME** to **@** (GoDaddy creates this by
   default).

Check from your Mac until it shows only your server's IP (minutes, sometimes
up to an hour):

```bash
dig +short vmock.fun
dig +short www.vmock.fun
```

Do not start the stack before this resolves: Caddy needs it to get the
HTTPS certificate.

## 3. Prepare the server

From your Mac, in the `vckscribble-be` repo:

```bash
scp deploy/setup-server.sh root@<server-ip>:
ssh root@<server-ip> bash setup-server.sh
```

It installs Docker, sets up the firewall, swap and automatic security
updates, and prints two **deploy keys**. Add each one to its repo on GitHub:
repo → Settings → Deploy keys → Add deploy key (leave write access **off**).
Adding deploy keys needs admin rights on the repo.

## 4. Get the code and configure it

On the server (`ssh root@<server-ip>`):

```bash
git clone git@github-vmock-be:shabbir642/vckscribble-be.git /opt/vmock-skribble/vckscribble-be
git clone git@github-vmock-fe:shabbir642/vckscribble-fe.git /opt/vmock-skribble/vckscribble-fe

cd /opt/vmock-skribble/vckscribble-be/deploy
cp .env.example .env
nano .env
```

For vmock.fun the `.env` is:

```bash
DOMAIN=vmock.fun, www.vmock.fun
CLIENT_ORIGIN=https://vmock.fun,https://www.vmock.fun
WORDS_API_TOKEN=<output of: openssl rand -hex 24>
IP_LIMIT_SCALE=1
```

## 5. Start it

```bash
docker compose up -d --build     # first build takes a few minutes
docker compose ps                # both services "running" / backend "healthy"
docker compose logs -f web       # watch Caddy get the certificate
```

Then from anywhere:

```bash
curl https://vmock.fun/api/health
```

Open https://vmock.fun on two devices and play a round.

## 6. Daily backups of the word database

```bash
chmod +x /opt/vmock-skribble/vckscribble-be/deploy/backup.sh
(crontab -l 2>/dev/null; echo "30 3 * * * /opt/vmock-skribble/vckscribble-be/deploy/backup.sh >> /var/log/vmock-backup.log 2>&1") | crontab -
```

Backups land in `/data/backups` on the volume; the last 14 are kept.

## 7. Watchdog

Restarts the stack if it is running but stuck (Docker already restarts a
container that crashes), and clears old images when the disk fills up:

```bash
(crontab -l 2>/dev/null; echo "* * * * * /opt/vmock-skribble/vckscribble-be/deploy/watchdog.sh >> /var/log/vmock-watchdog.log 2>&1") | crontab -
```

## Updating

```bash
cd /opt/vmock-skribble
git -C vckscribble-be pull && git -C vckscribble-fe pull
cd vckscribble-be/deploy && docker compose up -d --build
```

Games in progress pause for the few seconds the swap takes and carry on:
rooms are saved on shutdown and restored on boot. Always update both repos
together — the frontend and backend share a protocol version.

## Keeping an eye on it

- **Uptime alerts.** `.github/workflows/uptime.yml` checks the home page, the
  health endpoint, server lag and the game socket every 2 hours from
  GitHub. When the site is down it opens an issue labelled `outage`, which
  emails everyone watching the repo and the people it @mentions
  (`ALERT_MENTIONS`), and closes it when the site is back. Run it by hand from
  the repo's Actions tab → Uptime → Run workflow. GitHub pauses scheduled
  workflows after 60 days without a commit; re-enable it there if so.
- **Self-healing.** The watchdog (step 7) logs to `/var/log/vmock-watchdog.log`;
  a quiet log means nothing has gone wrong.
- `https://vmock.fun/api/health` reports players connected, rooms, memory and
  event-loop lag (`loopLagMs`, the number that means "lag" for players).
- `docker compose logs --tail 100 backend` shows joins, leaves, kicks, and
  errors reported by players' browsers.

## If something goes wrong

| Symptom | Check |
|---|---|
| Browser says the certificate is invalid | `dig +short vmock.fun` must show only your server; then `docker compose logs web` |
| Page loads, but stuck on "Connecting…" | `docker compose logs backend`; `CLIENT_ORIGIN` must match the address bar exactly |
| `docker compose up` fails building | `free -h` (is the swap on?) and re-run; the error is in the build output |
| Everything was fine, now it's down | `docker compose ps`; `docker compose up -d` restarts anything stopped |
