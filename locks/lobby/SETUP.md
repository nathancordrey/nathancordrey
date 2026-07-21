# Locks — Lobby service setup (Slice 2)

Stands up the lobby service on the same Linode. It runs in **memory mode**
with no database (fine for testing the deploy), then flips to **Postgres**
by setting `DATABASE_URL`. This slice also triggers the box-hygiene pass,
since real users and a database now land on the box.

## 1. Box hygiene (do this now — users + DB are arriving)

```bash
# firewall: allow ssh + http/https, deny the rest
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status

# automatic security updates
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Note: the game (:2567) and lobby (:2568) ports are NOT opened in ufw — they
are reached only through nginx on 80/443, which is correct. Keep them
localhost-only.

## 2. Postgres

```bash
sudo apt install -y postgresql
sudo -u postgres psql <<'SQL'
CREATE USER locks WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE locks OWNER locks;
SQL
```

Then create the schema (from the repo):

```bash
cd ~/code/nathancordrey/locks/lobby
npm ci
DATABASE_URL=postgres://locks:CHANGE_ME@localhost:5432/locks npm run migrate
```

Nightly backup (simple, effective):

```bash
# crontab -e  — dump the db every night, keep 7 days
0 3 * * * pg_dump -U locks locks | gzip > ~/backups/locks-$(date +\%F).sql.gz \
  && find ~/backups -name 'locks-*.sql.gz' -mtime +7 -delete
```

## 3. Lobby service

```bash
sudo cp locks/deploy/locks-lobby.service /etc/systemd/system/
# edit the unit: uncomment + set DATABASE_URL to the real password
sudo nano /etc/systemd/system/locks-lobby.service
sudo systemctl daemon-reload
sudo systemctl enable --now locks-lobby
journalctl -u locks-lobby -f
```

Without `DATABASE_URL` it boots in memory mode — sessions vanish on restart,
but every endpoint works, so you can verify the deploy before wiring the DB.

## 4. nginx + TLS

```bash
# DNS: A record  lobby.nathancordrey.com -> the Linode IP, let it resolve
sudo cp locks/deploy/nginx-lobby.conf /etc/nginx/sites-available/locks-lobby
sudo ln -s /etc/nginx/sites-available/locks-lobby /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d lobby.nathancordrey.com
```

Verify: `https://lobby.nathancordrey.com/health` →
`{"ok":true,"service":"locks-lobby","store":"postgres",...}`
(or `"store":"memory"` if you haven't set `DATABASE_URL` yet).

## What this slice does NOT do yet

Guest sessions exist but the client doesn't use them, and matchmaking still
runs on the game server's `joinOrCreate` pool. Slice 3 wires the client to
`POST /guest` and adds the quick-play broker (prefer-populated room pick +
signed join token). This slice is just the foundation standing up.

---

Slice 2 is complete. For the lobby-brokered quick-play rollout, see
`../SLICE3_DEPLOY.md`.
