# Node 24 patch review — 2026-11-15

Issue #248 aligns the existing Node 24 baseline, without a Node/npm major
migration or application dependency updates. **This is not a clean-image
claim or authorization to deploy.** Permanent image remediation #247 remains
OPEN at high priority; temporary policy implementation belongs to #273.

## Selected release and official image

Node **24.22.3** is the November 11 security release, fixing additional HIGH
HTTP/2/TLS issues independently of npm's dependencies. It replaces the older
24.22.1 baseline and the isolated 24.22.2 proposals.

All three Node `FROM` stages use:

```text
node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
```

Fresh anonymous Docker Hub registry requests verified the index, linux/arm64
child manifest and image-config bytes against SHA-256, not just a mutable tag:

| Object | SHA-256 |
| --- | --- |
| Index | `116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5` |
| linux/arm64 child | `f44b069ce4b5d00cb4f7dff81821a4a6953e3790420040abf300139b1d317c6c` |
| ARM64 config | `9ca3f7b76099c042f1e655ca8936e0a1ccda68b3c74a8a36375428ef76476d4e` |

The official-images library maps this tag to docker-node commit
`1274f3ee37d4d0e59d308ea25b83d9e21e4db862`, `24/alpine3.24`. The config reports
linux/arm64 and `NODE_VERSION=24.22.3`; that metadata is **not** runtime-test
evidence. The existing nginx final stage and all non-Node pins/config are
unchanged by #248.

## Fresh raw scan: acceptance still requires review

Checksum-verified Trivy **0.76.2**, DB updated
`2026-11-15T18:56:37.733847835Z`, scanned the exact index on **linux/arm64**
directly from the registry. The scan used HIGH/CRITICAL, ignore-unfixed and an
empty ignore file (no legacy exceptions or temporary risk acceptances).
It detected Alpine 3.24.4/19 OS packages and Node packages and exited **1**.

All six findings are HIGH, with published package fixes:

| Advisory | Package | Installed | Fixed versions reported |
| --- | --- | --- | --- |
| CVE-2026-102276 | brace-expansion | 5.0.9 | 5.0.10, 3.0.7, 2.1.5, 1.1.19 |
| CVE-2026-102278 | brace-expansion | 5.0.9 | 5.0.11, 3.0.8, 2.1.6, 1.1.20 |
| CVE-2026-109383 | undici | 6.28.0 | 6.29.1, 7.30.1, 8.12.2 |
| CVE-2026-109869 | undici | 6.28.0 | 6.29.1, 7.30.1, 8.12.2 |
| CVE-2026-19534 | undici | 6.28.0 | 6.28.1, 7.29.1, 8.10.2 |
| CVE-2026-87018 | undici | 6.28.0 | 6.29.1, 7.30.1, 8.12.2 |

Trivy target/type: `Node.js` / `node-pkg`. Exact package paths, without a
leading slash in the report:

- brace-expansion: `usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json`
- undici: `usr/local/lib/node_modules/npm/node_modules/undici/package.json`

These are **npm-bundled packages**, not evidence that Node's internal fetch
uses undici 6.28.0. Official 24.22.3 source and the separately executed x64
host binary report internal undici **7.30.2**; npm **11.19.1** separately
bundles undici **6.28.0**. npm executes during image preparation and
migration/bootstrap tooling, so "not an application dependency" is not proof
of no exposure.

No acceptance is added in this change. Once #273 is validated/merged, the
coordinator must obtain explicit review of **this new digest and all six exact
advisory/package/path combinations** before adding data using that policy.
No existing acceptance may transfer merely because the Node tag or target
name looks similar. Keep raw reports and accepted-risk summaries visible, use
the bounded review/expiry policy, and retain every CI/security gate.

Reproduce the raw review separately from policy evaluation:

```bash
trivy image --image-src remote --platform linux/arm64 \
  --severity HIGH,CRITICAL --ignore-unfixed --ignorefile '' \
  --exit-code 1 --no-progress --format json --output node-candidate-raw.json \
  node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
```

Local evidence: `/tmp/opencode/pto-issue-248-node-baseline-20261115/`
contains registry bytes, scanner command/log/raw JSON and summaries. Raw
JSON SHA-256:
`f0c00d5578684bd09d60d224eda36a8242973b3e964256b82867c2760507f17d`.

## Executed host check versus pending container checks

The official `node-v24.22.3-linux-x64.tar.xz` was downloaded to isolated
temporary tool storage and verified against the official `SHASUMS256.txt`:
`4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb`.
The binary executes as `v24.22.3` on linux/x64; global nvm/defaults are unchanged.
Host evidence lives in
`/tmp/opencode/pto-issue-248-node-toolchain-20261115/host-summary.json`.

Exact-version CI assertions now export and execute the actual
`backend:build`, `frontend:build` and `backend:runtime` targets. This includes
the backend build used by production bootstrap/all-in-one migrations and
the runtime used by production migrations/API. Frontend's final nginx image
has no Node runtime; its real builder is tested instead. Existing service and
application smoke remain. CI runs these containers natively on its runner;
the ARM64 raw scan is not ARM64 runtime execution.

Local container execution is unavailable because rootless Podman cannot create
namespaces. No privileged workaround was attempted. Container build/smoke,
backup roundtrip, integration coverage and Chromium E2E are still required on
the final rebased candidate, using the coordinator's exclusive disposable
test lease where applicable. All current CI checks and independent review
remain merge prerequisites; this local candidate is not pushed or merge-ready.

Isolated checks passed with the verified Node 24.22.3 host toolchain:
repository/infra formatting, both workspaces' lint/typecheck/unit tests
(backend 269, frontend 272), frontend coverage (92.92% lines, all existing
per-path gates retained), both builds, Node baseline/20 runtime regressions,
production config/deployment script/sunset checks, and npm audit (production
clean; seven development MODERATE findings, no HIGH/CRITICAL). CI YAML and
probe shell syntax/Compose target mappings were validated without containers.
The shared lockfile was compared structurally with the base: only the root
Node engine floor changed, not a single dependency resolution. Logs and
statuses are retained in the evidence directory's `isolated-gates/`.

## Pending dependency PR disposition

- **#241** (`c7b58838b1a77dcd9d140ac55766fb37cd96e2cd`) updates only backend
  Node stages to 24.22.2. **#244**
  (`b31863b84c3248ff9b3a6bc34fc2e12d92b62c05`) changes only frontend's builder.
  Both fail Deployment config/exact baseline checks. The coordinated #248
  patch supersedes their relevant intent with 24.22.3 in all stages, `.nvmrc`,
  minimum baseline and root engine/lock metadata. Do not merge either
  isolated proposal. Closing/replacing them remains a maintainer action only
  after the reviewed replacement PR exists.
- **#245** (`f3ce6639655e094867712ddf5e006a1c99fa6b80`) was reviewed read-only:
  13 minor/patch updates across backend/frontend manifests and the shared
  lockfile (dotenv, typescript-eslint, icons/motion/router, Playwright,
  Tailwind/Vite tooling and globals). Its last CI was 10/11 green, with
  Security scan failing. **Retain it as a separate dependency deliverable**,
  not part of the Node patch. After the policy/Node baseline merges, rebase
  and review its resolved graph in the single lockfile lane, preserving the
  new root engine metadata. Require `npm ci`, fresh audit/full green CI and
  no stale resolutions; its old checks are not sufficient. No external
  branch was rebased, rewritten, closed or merged here.
- Vitest/coverage, MSW, TypeScript, Express/body-parser, limiter/store, Prisma,
  React and ESLint major migrations remain separate backlog issues. #248
  changes only root lockfile engine metadata, not package resolutions.

## Official references

- [Node 24.22.3 security release](https://nodejs.org/en/blog/release/v24.22.3)
- [Official release checksums](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt)
- [Official Node image library](https://github.com/docker-library/official-images/blob/master/library/node)
- [Pinned official Alpine recipe](https://github.com/nodejs/docker-node/blob/1274f3ee37d4d0e59d308ea25b83d9e21e4db862/24/alpine3.24/Dockerfile)
- [Internal undici source metadata](https://github.com/nodejs/node/blob/v24.22.3/deps/undici/src/package.json)
- [npm source metadata](https://github.com/nodejs/node/blob/v24.22.3/deps/npm/package.json)
- [Runtime version API](https://nodejs.org/docs/v24.22.3/api/process.html#processversion)
- [Docker multi-stage target behavior](https://docs.docker.com/build/building/multi-stage/)
