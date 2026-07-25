# Production Deployment & Operations

This document is the operator runbook for running PTO Calendar on an Oracle
Cloud Always Free VM (or any Ubuntu 22.04 host with Docker). It covers
one-time provisioning, day-to-day deploys, backup verification, disaster
recovery, and `SESSION_SECRET` rotation.

For application-level architecture, environment variables, and the Caddy →
nginx → backend topology, see `README.md` § "Production Deployment" and
`docs/technical-spec.md` § 8.

## 1. Provision the OCI VM

### Shape
- **Shape**: `VM.Standard.A1.Flex` (Always Free — 4 OCPU + 24 GB RAM per tenancy).
- **Recommended allocation**: **2 OCPU + 12 GB RAM**. Postgres + Node + nginx + Caddy fits comfortably; leave ~50% of the tenancy quota free for the boot volume, headroom, and a future second instance.
- **Image**: Ubuntu 22.04 LTS, aarch64 (Canonical-provided, marked "Always Free-eligible").
- **Boot volume**: 50 GB (default is fine).

### Networking
- **Reserved public IP**: OCI Console → Networking → IPs → Reserve. Ephemeral IPs are released when the instance stops and the cert breaks; always reserve.
- **VCN security list** (default VCN works): allow ingress on **22** (your IP only), **80**, and **443** (0.0.0.0/0). Egress is open by default.

### DNS
- Create an `A` record `pto.yourcompany.com` → the reserved public IP.
- Wait for propagation (TTL-dependent; usually minutes) before the first deploy — Caddy needs the host to resolve before it can issue the Let's Encrypt cert on first request.

### First-boot SSH
- OCI Console → Instances → Instance details → Console connection (or `ssh ubuntu@<reserved_ip>` if your public key was added at launch).
- The default user is `ubuntu`. `root` is reachable via `sudo`.

## 2. First-time setup (`setup.sh`)

The script at `infra/deploy/setup.sh` provisions everything end-to-end.
Re-running it on an existing install is a no-op for already-done steps; it
performs `git pull` + `docker compose up -d --build` instead of cloning.

### Prerequisites
- Root or `sudo` access on the VM.
- DNS record already pointing at the reserved IP.
- Outbound HTTPS to `download.docker.com`, `github.com`, and Let's Encrypt (`acme-v02.api.letsencrypt.org`).

### Run

```bash
# Option A: copy setup.sh from your local clone (recommended for first run).
# On your laptop:
scp infra/deploy/setup.sh ubuntu@<VM_IP>:/tmp/setup.sh

# On the VM:
sudo bash /tmp/setup.sh
```

`setup.sh` will refuse to run unless all five required env vars are set. Pick a strong `DB_PASSWORD` (e.g. `openssl rand -hex 24`) before running:

```bash
export HOST=pto.yourcompany.com
export ACME_EMAIL=ops@yourcompany.com
export DB_PASSWORD="$(openssl rand -hex 24)"
export LEAD_EMAIL=lead@yourcompany.com
export CORS_ORIGIN="https://pto.yourcompany.com"
sudo -E bash /tmp/setup.sh
```

### What `setup.sh` does, in order
1. Validates Ubuntu 22.04.
2. Validates input env vars (hostname shape, email shape, URL shape).
3. Installs `docker-ce`, `docker-compose-plugin`, `git`, `openssl` via apt (idempotent — skips if already present).
4. Creates the unprivileged `deploy` user with `/bin/bash`, adds it to the `docker` group (no `sudo`), pre-creates `/home/deploy/.ssh` with `0700`. Idempotent.
5. Clones the repo to `/opt/pto-calendar` as `deploy` (or `git pull`s if it's already there).
6. Writes `/opt/pto-calendar/.env` with a **48-byte random `SESSION_SECRET`** (preserved across re-runs so existing sessions stay valid), the operator-supplied `HOST` / `ACME_EMAIL` / `CORS_ORIGIN` / `DB_PASSWORD` / `LEAD_EMAIL` / `LEAD_NAME` / `LEAD_COLOR_CODE`. File mode `0600`.
7. Runs `docker compose -f docker-compose.prod.yml up -d --build`.
8. Polls `http://localhost/health` for up to 60 s.
9. Runs `db:bootstrap` against the running stack via `docker compose run --rm backend npx tsx backend/prisma/bootstrap.ts` (re-uses the backend image; no need to install Node on the host).
10. Prints the `/setup-account?token=...` link to stdout.

### After `setup.sh` completes
1. **Copy the setup link** from stdout and open it in a browser. Set the team-lead password.
2. **Log in** at `https://pto.yourcompany.com/`.
3. Visit `/admin/users` and add the rest of the team. Each new user receives a one-time setup link to set their own password.
4. **Add the deploy key** to `/home/deploy/.ssh/authorized_keys` (if you'll use tag-driven CI deploys — see § 6):
   ```bash
   sudo -u deploy bash -c 'umask 077 && cat >> ~/.ssh/authorized_keys' < /tmp/pto-calendar-deploy-key.pub
   ```
   Use a **dedicated ed25519 pair** with no passphrase; rotate quarterly.

## 3. Deploying releases

### Manual deploy (latest `main`)
SSH in as `deploy`:
```bash
ssh deploy@pto.yourcompany.com
cd /opt/pto-calendar
./infra/deploy/deploy.sh
```

### Manual deploy of a tagged release
```bash
./infra/deploy/deploy.sh v1.2.3
```

### Tag-driven deploy (CI)
After the `deploy.yml` workflow is merged, simply push a tag from your local machine:
```bash
git tag v1.2.3
git push origin v1.2.3
```
The CI runner builds the tag, SSHes in as `deploy`, and runs `./infra/deploy/deploy.sh "$TAG"`. See § 6 for repo-secret setup.

### What `deploy.sh` does
1. Sources `HOST` from `/opt/pto-calendar/.env`.
2. Refuses if the working tree is dirty (uncommitted edits).
3. `git fetch --all --tags && git checkout <ref>` (and `git pull --ff-only` for branch refs).
4. `docker compose -f docker-compose.prod.yml up -d --build`.
5. `docker image prune -f` (clean dangling layers from the previous build).
6. Polls `https://${HOST}/health` for up to 60 s. **Caddy fronts everything**; a 200 here means TLS is live, nginx is up, and the backend answered.

### Rollback
`./deploy.sh` checks out any git ref (tag, branch, or commit SHA) and re-ups compose. To roll back to `v1.1.0`:
```bash
ssh deploy@pto.yourcompany.com
cd /opt/pto-calendar
./infra/deploy/deploy.sh v1.1.0
```

## 4. Backups

### Schedule
- `infra/db/backup.timer` runs `infra/deploy/backup.sh` **daily at 03:00 UTC** as the `deploy` user.
- `Persistent=true` means a missed run (instance stopped) catches up on next boot.
- `RandomizedDelaySec=300` spreads the start across a 5-minute window (useful if you ever scale to multiple VMs).

### Install the timer once
```bash
sudo cp /opt/pto-calendar/infra/db/backup.service /etc/systemd/system/backup.service
sudo cp /opt/pto-calendar/infra/db/backup.timer   /etc/systemd/system/backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now backup.timer
sudo systemctl list-timers backup.timer   # confirm NEXT shows <24h
```

### What `backup.sh` produces
- `/opt/backups/pto-YYYYMMDD.sql.gz` (UTC date stamp, ~1–10 MB).
- Mode `0600`; rotated after 7 days.
- `pg_dump --no-owner --no-acl` — clean restore on any Postgres 14+.

### Verify a backup
```bash
ssh deploy@pto.yourcompany.com
zcat /opt/backups/pto-20250101.sql.gz | head -50    # first 50 lines of schema
zcat /opt/backups/pto-20250101.sql.gz | grep -c INSERT  # row count sanity
```

### Backup scope (deliberate)
Backups live **on the same VM**. If the instance is reclaimed or its boot
volume is corrupted, the backups die with it. This is acceptable for an
internal team tool of <100 users; for higher-stakes data, add an Object
Storage sync as a follow-up (out of scope per issue #102).

### Restore
```bash
ssh deploy@pto.yourcompany.com
cd /opt/pto-calendar
zcat /opt/backups/pto-20250101.sql.gz \
  | docker compose -f docker-compose.prod.yml exec -T db \
      psql -U pto -d pto --single-transaction
```
Run `./infra/deploy/deploy.sh main` afterwards to make sure any pending
migrations are applied on top of the restored schema.

## 5. Disaster recovery

If the VM is lost (reclaimed, corrupted boot volume, region outage):

1. **Re-provision** a fresh VM per § 1 (same shape, same reserved IP if reclaiming it is impossible, otherwise a new reserved IP + new DNS A-record + Caddy reissues the cert automatically).
2. **Re-run `setup.sh`** per § 2, reusing the previous `HOST`, `ACME_EMAIL`, `LEAD_EMAIL`, `CORS_ORIGIN`, and `LEAD_NAME`. Use a **new `DB_PASSWORD`** — the old one only existed in `/opt/pto-calendar/.env` on the lost VM.
3. **Restore the latest backup** via the § 4 restore recipe, pointed at the new VM.
4. **Re-bootstrap the team lead**: re-running `setup.sh` regenerates a setup token if the existing lead has no password (otherwise no-op). Visit the new link, set a password, log in.

Recovery time: 15–30 minutes for an experienced operator with the backup file on hand.

## 6. `SESSION_SECRET` rotation

The boot-time env validator in `backend/src/config/env.ts` accepts a
**comma-separated** `SESSION_SECRET` value: the first key is used to **sign**
new sessions; any key in the list can **verify** them. This enables
graceful rotation without invalidating active sessions.

### Rotate
```bash
ssh deploy@pto.yourcompany.com
cd /opt/pto-calendar
# 1. Generate a new key
NEW="$(openssl rand -base64 48)"
# 2. Read the current value
OLD="$(grep -E '^SESSION_SECRET=' .env | head -n1 | cut -d= -f2-)"
# 3. Write the combined value (NEW signs, OLD verifies)
sed -i.bak -E "s|^SESSION_SECRET=.*$|SESSION_SECRET=${NEW},${OLD}|" .env
chmod 0600 .env
# 4. Restart so the backend re-reads .env
./infra/deploy/deploy.sh main
# 5. After all old sessions have expired (default cookie max-age is one day),
#    drop the OLD key by editing .env to `SESSION_SECRET=${NEW}` only.
```

If you **lose** the old `SESSION_SECRET` (e.g. the `.env` file is corrupted
and you have no backup), all existing sessions are invalidated at the next
backend restart. Users will be prompted to log in again — this is an
acceptable recovery; it is **not** a data loss event.

## 7. Always Free caveats

- **24 GB RAM total per tenancy.** Running two `VM.Standard.A1.Flex` instances at full allocation (4 OCPU + 24 GB each) exceeds the quota. Stick to **2 OCPU + 12 GB** on a single instance for this app.
- **Idle reclaim.** If the instance is **stopped** for more than 7 days, OCI may reclaim it. Always-on services (Caddy + nginx + Node + Postgres) keep the CPU non-zero, so an idle-running instance is **not** at risk; a stopped one is.
- **Boot volume limits.** Always Free boot volumes cap at 200 GB total per tenancy. Default 50 GB is fine.
- **Outbound bandwidth.** Always Free egress is **10 TB / month**. An internal team tool is well under this; if you serve large static assets externally, monitor the meter.
- **Single region.** The home region is pinned at tenancy creation. There is no migration; choose carefully.
- **Reclamation rescue.** If reclaimed, a new instance can usually be created within an hour. Data recovery requires a backup file (§ 4) that was synced **off** the instance.

## 8. Operator checklist

| When | Step |
|---|---|
| First time | Provision VM per § 1, run `setup.sh` per § 2, complete the setup link, add team members via `/admin/users`. |
| Cutting a release | Tag and push (`git tag vX.Y.Z && git push origin vX.Y.Z`); CI deploys. Manual fallback: `./infra/deploy/deploy.sh vX.Y.Z`. |
| Weekly | `zcat /opt/backups/pto-*.sql.gz \| head` (rotate between two recent files) to confirm backups are parseable. |
| Quarterly | Rotate `SESSION_SECRET` per § 6. Rotate the deploy SSH key per § 2 (last bullet). |
| Yearly | Review the OCI Always Free quotas (§ 7); check the metering page for egress. |
| After a security incident | Rotate `SESSION_SECRET` and the deploy key; pull the latest main (which gets the env-validator hardening merged in #116 and follow-ups); re-deploy. |

## 9. Out of scope (deferred)

- Off-VM backup sync (Object Storage). Issue #102 explicitly excludes this; file a follow-up if the data matters enough.
- Monitoring and alerting. The stack has `/health` and `/ready` probes for orchestrators but no Prometheus exporter, no log aggregation, no uptime alerts. Add a follow-up issue if the team needs it.
- Multi-region / HA. Always Free's single-region constraint makes HA impractical; for production HA, move off Always Free.
- Auto-TLS via DNS-01 challenge. Caddy already uses HTTP-01 + Let's Encrypt; no change needed.
