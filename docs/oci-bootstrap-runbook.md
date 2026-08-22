# OCI Bootstrap Runbook

These steps provision the OCI Always Free VM and complete the Supabase-to-OCI
cutover. The repository ships the application code, Docker Compose, Caddy
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
  Key:   pto.role
  Value: production
```

The tag is mandatory: the dynamic group matches `tag.pto.role=production`,
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
pto.example.com.   300   A   <reserved-public-ip>
```

Lower TTL after cutover if the old value was higher.

## 4. Configure the GitHub repository

### Variables (Settings -> Secrets and variables -> Actions -> Variables)

| Variable | Value |
|---|---|
| `OCI_PRODUCTION_DEPLOY_ENABLED` | `true` |
| `OCI_HOST` | the OCI hostname, e.g. `pto.example.com` |
| `OCI_DEPLOY_USER` | the SSH user, e.g. `deploy` |
| `GCP_FALLBACK_DEPLOY_ENABLED` | `false` |

### Secrets (Settings -> Secrets and variables -> Actions -> Secrets)

| Secret | Source |
|---|---|
| `OCI_KNOWN_HOSTS` | output of `ssh-keyscan -H <OCI_HOST>` on the VM |
| `OCI_SSH_PRIVATE_KEY` | the deploy key's private key (no passphrase) |

`PRODUCTION_DEPLOY_ENABLED` (the old GCP variable) must be removed or set to
`false` so a stray Cloud Run deploy cannot fire.

## 5. Run setup.sh on the VM

```bash
ssh deploy@<OCI_HOST>

# Install the prerequisites Ubuntu 24.04 may not include by default
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssl ufw

# Optional hardening before deploy
sudo ufw default deny incoming
sudo ufw allow from <admin-ip> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Copy infra/deploy/setup.sh from the repo, then run
export HOST=pto.example.com
export CORS_ORIGIN=https://pto.example.com
export ACME_EMAIL=ops@example.com
export RELEASE_REF=v1.1.0
export DB_PASSWORD="$(openssl rand -hex 24)"
export SESSION_SECRET='<copied-from-cloud-run-secret-manager>'
export RATE_LIMIT_REDIS_URL='rediss://<upstash-connection-url>'
export BACKUP_ENCRYPTION_KEY='<strong-key-from-secure-vault>'
export OCI_BACKUP_BUCKET=pto-calendar-backups
export OCI_OBJECT_STORAGE_NAMESPACE=$(oci os ns get --auth instance_principal | jq -r .data)
export OCI_REGION=$(oci iam region-subscription list --auth instance_principal | jq -r '.data[0].region-name')
export SKIP_BOOTSTRAP=true

sudo -E bash setup.sh
```

`setup.sh` must end with `[setup] OCI setup complete`. Both
`https://${HOST}/health` and `https://${HOST}/ready` must respond `200`.

## 6. Restore the Supabase database into the OCI container

```bash
# From the trusted workstation, copy the latest archive
ARCHIVE=$(gh workflow run database-backup.yml --ref v1.1.0 >/dev/null && \
  gh run list --workflow database-backup.yml --limit 1 --json databaseId \
    --jq '.[0].databaseId' | xargs -I{} gh run view {} --json jobs \
    --jq '.jobs[0].outputs.archive_name')
scp ${ARCHIVE} ${ARCHIVE}.sha256 deploy@${HOST}:/home/deploy/

# Restore into the OCI PostgreSQL container
ssh deploy@${HOST}
/opt/pto-calendar/infra/deploy/restore-oci.sh \
  --archive /home/deploy/${ARCHIVE} \
  --confirm-production-target
```

## 7. Verify and cut over

```bash
ssh deploy@${HOST}
curl -kfsS --max-time 10 https://${HOST}/health
curl -kfsS --max-time 10 https://${HOST}/ready

# Login and test PTO CRUD in the browser through the OCI host
```

When the smoke tests pass, switch the DNS A record to the OCI reserved IP.
Confirm the first scheduled `pto-calendar-backup.timer` run completes and
that `oci os object list --bucket-name pto-calendar-backups` shows the new
archive.

## 8. Rollback (if needed)

If OCI has accepted no writes, revert DNS to the previous Firebase/Cloud
Run endpoint and disable the OCI workflow with
`OCI_PRODUCTION_DEPLOY_ENABLED=false`.

If OCI has accepted writes, freeze writes, create an encrypted OCI backup
with `infra/deploy/backup.sh`, restore it into Supabase after a disposable
validation, and only then revert DNS.

## 9. Tear down the GCP fallback

After at least one successful OCI restore drill and one successful scheduled
backup, the Cloud Run/Firebase/Supabase deployment may be torn down. Until
then, keep it intact as the rollback window.
