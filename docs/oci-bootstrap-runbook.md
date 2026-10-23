# OCI Bootstrap Runbook

> **Hostname for this deployment:** `pto-calendar.lhsalas.com`
>
> Every command in this file substitutes this value as `$HOST`. Replace it
> with your own hostname in a new release if you fork the deployment.

These steps provision an OCI Always Free VM for first-time setup or recovery.
The original database migration is complete. The repository ships the
application code, Docker Compose, Caddy
config, deployment scripts, systemd timer, and the OCI tag-triggered
deploy workflow; the operator is responsible for the OCI-side resources that
require a console or VM.

## 1. Verify the existing OCI resources

The current OCI tenancy already contains:

- A private Object Storage bucket `pto-calendar-backups` with a 30-day
  object lifecycle policy.
- A dynamic group `pto-calendar-vm` whose instance-principal policy allows
  `manage objects` and `use buckets` on the compartment.
- A reserved public IP, attached as the primary VNIC on the OCI VM.

The VM uses Ubuntu 24.04 LTS, ARM64/aarch64. Update the rest of the OCI
side:

```text
Compute -> Instances -> pto-calendar -> Edit -> Tags
  Key:   ptorole
  Value: production
```

The tag key cannot contain dots (OCI rejects them), so the production tag
is `ptorole=production`. The dynamic group matches `tag.ptorole=production`,
and `infra/deploy/backup.sh` uses the instance principal to put encrypted
archives into the bucket. Without the tag, `backup.sh` fails with
`Authorization failed or requested resource not found`.

If the VM does not yet carry the tag, attach it now. A restart is not
required; instance-principal authorization resolves the tag on each API
call.

## 2. Install and configure the OCI CLI on the VM

```bash
# Ubuntu 24.04 aarch64
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends python3 python3-venv unzip

bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
# accept defaults; installs to ~/.local/bin

export PATH="$HOME/.local/bin:$PATH"
oci --version

# Configure instance-principal auth (no API key required)
mkdir -p ~/.oci
cat > ~/.oci/config <<'EOF'
[DEFAULT]
user=ocid1.user.oc1..placeholder
fingerprint=placeholder
tenancy=ocid1.tenancy.oc1..placeholder
region=us-ashburn-1
key_file=
EOF

# Smoke test
oci os ns get --auth instance_principal
oci os object list \
  --bucket-name pto-calendar-backups \
  --auth instance_principal
```

The bucket listing must succeed; if it returns `Authorization failed`, the
tag or policy is not yet effective.

## 3. Configure DNS

Create the DNS `A` record pointing to the OCI reserved public IP at least
24 hours before cutover with a 300-second TTL:

```
pto-calendar.lhsalas.com.   300   A   <reserved-public-ip>
```

Lower TTL after cutover if the old value was higher.

## 4. Configure the GitHub repository

### Variables (Settings -> Secrets and variables -> Actions -> Variables)

| Variable | Value |
|---|---|
| `OCI_PRODUCTION_DEPLOY_ENABLED` | `true` |
| `OCI_HOST` | `pto-calendar.lhsalas.com` |
| `OCI_DEPLOY_USER` | the SSH user, e.g. `deploy` |

### Secrets (Settings -> Secrets and variables -> Actions -> Secrets)

| Secret | Source |
|---|---|
| `OCI_KNOWN_HOSTS` | pinned key for the reserved IP, collected with `ssh-keyscan -H <reserved-public-ip>` and independently verified |
| `OCI_SSH_HOST` | reserved public IP used for the SSH connection |
| `OCI_SSH_PRIVATE_KEY` | the deploy key's private key (no passphrase) |

Verify the SSH host key fingerprint through a trusted console before pinning
`OCI_KNOWN_HOSTS`. SSH connects to `OCI_SSH_HOST`, not the public HTTPS hostname.
The workflow reads only these three secrets and three variables. Keep
`OCI_DB_PASSWORD`, `OCI_SESSION_SECRET`, `OCI_RATE_LIMIT_REDIS_URL`, and
`OCI_BACKUP_ENCRYPTION_KEY` as recovery copies, with matching values in an
external password vault; the application reads its VM-local protected `.env`.

## 5. Run setup.sh on the VM

```bash
ssh deploy@pto-calendar.lhsalas.com

# Install the prerequisites Ubuntu 24.04 may not include by default
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssl ufw

# Optional hardening before deploy.
# Port 22 stays open to the world because the operator's public IP is dynamic.
# The OCI reserved public IP and a key-only sshd config keep it safe in
# practice (PasswordAuthentication no, KbdInteractiveAuthentication no,
# PermitRootLogin no, AllowUsers deploy ubuntu).
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Copy infra/deploy/setup.sh from the repo, then run.
# All four secrets below are GitHub repository secrets (Settings -> Secrets
# and variables -> Actions -> Repository secrets):
#   OCI_SESSION_SECRET          Existing session signing key from recovery vault
#   OCI_BACKUP_ENCRYPTION_KEY   Strong key for gpg --symmetric on daily archives
#   OCI_RATE_LIMIT_REDIS_URL    Upstash rediss:// connection URL
#   OCI_DB_PASSWORD             PostgreSQL role password; generate fresh or reuse
export HOST=pto-calendar.lhsalas.com
export CORS_ORIGIN=https://pto-calendar.lhsalas.com
export ACME_EMAIL=ops@example.com
export RELEASE_REF=v1.1.0
export OCI_SESSION_SECRET='<session signing key from recovery vault>'
export OCI_RATE_LIMIT_REDIS_URL='<Upstash TLS URL from recovery vault>'
export OCI_BACKUP_ENCRYPTION_KEY='<archive encryption key from recovery vault>'
export OCI_DB_PASSWORD='<database password from recovery vault (16-128 URL-safe chars)>'
export OCI_BACKUP_BUCKET=pto-calendar-backups
export OCI_OBJECT_STORAGE_NAMESPACE=$(oci os ns get --auth instance_principal | jq -r .data)
export OCI_REGION=$(oci iam region-subscription list --auth instance_principal | jq -r '.data[0].region-name')
export SKIP_BOOTSTRAP=true

sudo -E bash setup.sh
```

`setup.sh` must end with `[setup] OCI setup complete`. It verifies
the backend `/health` and `/ready` over the docker network (no DNS/cert
required). It then attempts `https://${HOST}/health` through Caddy as a
best-effort check — if Caddy has not yet obtained a certificate because
the DNS `A` record for `${HOST}` does not resolve to this VM, `setup.sh`
prints a warning explaining how to fix it (switch the `A` record, then
`sudo docker compose -f /opt/pto-calendar/docker-compose.prod.yml
restart caddy`) but exits 0 because the stack itself is functional.

## 6. Restore an OCI backup into the replacement VM

For a recovery, download the encrypted OCI Object Storage archive and matching
checksum with an authorized operator account. Verify a disposable restore first
using `docs/database-backups.md`. Copy only the encrypted files to the
replacement VM; never run the production command on the healthy live VM as a
routine drill.

```bash
# From the trusted workstation's download directory
ARCHIVE=pto-<timestamp>.tar.gz.gpg
scp "${ARCHIVE}" "${ARCHIVE}.sha256" deploy@<replacement-vm-ip>:/home/deploy/

# Restore into the OCI PostgreSQL container
ssh deploy@<replacement-vm-ip>
cd /home/deploy
/opt/pto-calendar/infra/deploy/restore-oci.sh \
  --archive pto-<timestamp>.tar.gz.gpg \
  --confirm-production-target
```

## 7. Verify and accept recovery

```bash
ssh deploy@pto-calendar.lhsalas.com
curl -fsS --max-time 10 https://pto-calendar.lhsalas.com/health
curl -fsS --max-time 10 https://pto-calendar.lhsalas.com/ready

# Login and test PTO CRUD in the browser through the OCI host
```

For an actual VM replacement, switch the reserved IP or DNS only after the
recovered app passes validation. Confirm the next scheduled backup timer run
and matching off-VM archive/checksum. Record evidence in `docs/cutover-drill.md`.

## 8. Rollback (if needed)

Deploy a known-good OCI release compatible with the current database schema,
or recover onto a replacement OCI VM. Migrations are forward-only. Back up
current data and freeze writes before destructive restores. Do not route users
back to a stale legacy database.

## 9. Retired deployment configuration

The old deployment workflows and docs are retired in #223. After recording a
successful scheduled OCI backup and the prior successful OCI restore, follow the exact
GitHub configuration allowlist in `docs/deploy.md` section 9 / issue #222.
Cloud resources, archived backups/keys, DNS, and the existing Firebase redirect
are not changed by this sunset. Any cloud teardown needs separate approval.
