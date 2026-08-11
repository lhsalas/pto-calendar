# Running the dev stack on Podman

The `npm run db:up` / `app:up` / `app:down` / `app:reset` scripts work
identically with Podman 5.x and Docker 24+. A tiny wrapper at
`bin/container.mjs` auto-detects which engine is installed (prefers Podman,
falls back to Docker) and forwards every argument to the chosen CLI — no
separate scripts, no duplicated compose files, no system-level path
configuration.

## Prerequisites

- **Podman 5.x** on Fedora / RHEL / Silverblue:
  ```bash
  sudo dnf install podman
  ```
- **Docker Desktop** or **Docker Engine** on macOS / Windows / Ubuntu:
  <https://docs.docker.com/engine/install/>
- Node.js ≥ 20 (already required by the project).
- **A compose provider.** Podman 5.x delegates the `compose` subcommand to an
  external provider — it does not bundle one. Install whichever matches your
  distro:
  - Fedora 41+ and most RPM-based distros: `sudo dnf install podman-compose`
  - Debian / Ubuntu: `sudo apt install docker-compose-plugin`
  - macOS / Windows: Docker Desktop ships the Compose plugin by default

  Verify with `podman compose version` (or `docker compose version`) — it
  should print a version string, not "compose provider not found."

No `docker-compose` symlink, no `alias docker=podman`, no shell profile edit.

## Quick smoke test

```bash
node bin/container.mjs --version      # should print `podman 5.x.x` on Fedora
node bin/container.mjs compose version
node bin/container.mjs compose -f docker-compose.yml up -d db
node bin/container.mjs compose -f docker-compose.yml ps
node bin/container.mjs compose -f docker-compose.yml down
```

Then run the project end-to-end with the wrapper:

```bash
npm run db:up                # starts pto-calendar-db on :5432
cp backend/.env.example backend/.env
npm run db:migrate
npm run db:seed
npm run dev
# or, for the all-in-one stack:
npm run app:up               # db + migrate + backend + nginx-served SPA on :5173
```

## What works out of the box

- `docker-compose.yml` (dev Postgres)
- `docker-compose.app.yml` (all-in-one: db + migrate + backend + frontend)
- All host ports the dev/app stacks bind (5432, 5173) are above 1024, so no
  `net.ipv4.ip_unprivileged_port_start` sysctl tweak is needed under
  rootless Podman.

Podman 5.x's built-in `podman compose` (go-compose library) supports every
compose-spec feature used by these two files: `healthcheck`,
`depends_on.condition: service_healthy / service_completed_successfully`,
named volumes, top-level `name:`, `restart: unless-stopped`.

## Detection order and overrides

`bin/container.mjs` probes engines in this order: **podman → docker**. The
first one whose `--version` exits 0 wins. If a host has both installed
(uncommon), Podman wins. To force a specific engine, invoke it directly:

```bash
podman compose -f docker-compose.yml up -d db
docker compose -f docker-compose.yml up -d db
```

There is intentionally **no `CONTAINER_CLI` env-var override** — keeping
the wrapper single-purpose and the script small is the goal.

## Out of scope

- **Cloud production deployment** — production uses Cloud Run, Firebase
  Hosting, and Supabase. Podman remains supported for the local Docker Compose
  development and all-in-one demo stacks only; see `docs/deploy.md`.
- **Podman quadlets / `podman kube play`** — separate architectural
  decision.
- **CI runners** — GitHub Actions uses the `postgres:16` service
  container directly, not compose; no change needed.

## Troubleshooting

- **`error: no container engine found.`** — neither `podman` nor
  `docker` is on `PATH`. Install one (see Prerequisites).
- **`looking up compose provider failed …`** — `podman compose` (or
  `docker compose`) is delegating to an external provider that isn't
  installed. On Fedora 41+ run `sudo dnf install podman-compose`; on
  Debian/Ubuntu run `sudo apt install docker-compose-plugin`.
- **Volume permission errors on rootless Podman** — make sure
  `podman info` shows `rootless: true` and your user is in the
  `/etc/subuid` / `/etc/subgid` range. The dev/app stacks only use
  named volumes (not host bind mounts), so this is usually a
  non-issue.
