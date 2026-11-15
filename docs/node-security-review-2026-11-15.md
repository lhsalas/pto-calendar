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

## Raw evidence and explicit temporary acceptance

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

### Dated #248 new-digest review — 2026-11-15

The policy-only #273 did **not** pre-authorize this replacement. After #273
merged at `ada8e0ba61d20bdc4a27cb6d06c314b3bd71b15e`, the coordinator explicitly
authorized applying the independently reviewed #248 Node entry under the
owner's 2026-11-15 temporary decision. **All six exact new-digest tuples above
were reviewed**, not inherited from the old digest.

The manifest replaces the obsolete 24.22.1 entry with the exact reviewed
24.22.3 entry and its Alpine 3.24.4/`Node.js` coverage targets. The three
temporary matches are undici CVE-2026-109383, CVE-2026-109869 and CVE-2026-87018.
The unchanged, hash-bound legacy YAML separately accounts for brace-expansion
CVE-2026-102276/CVE-2026-102278 and undici CVE-2026-19534. Those three were also
explicitly included in this new-digest review; no legacy scope or expiry changed.

Approved proposal: `policy-review/proposed-node-entry.json`, SHA-256
`1588794398fe9fe68ecf76e90d91d9a973c56a146094303f528f057f9dc8bdf8`.
The source entry must be structurally identical. All global fields, the other
three image entries and the legacy hash remain unchanged; the first temporary
expiry remains **2026-12-15 at 00:00 UTC**, not a restarted review clock.

The full evidence packet is under
`/tmp/opencode/pto-issue-248-node-baseline-20261115/policy-review/`.
Its subsequent **fixed-DB repeat, not a fresh-advisory check**, used the
canonical DB updated above, SHA-256
`e22c0a587282c1e3f3cd7f8aaded14f60d3c8bbd22ee9edb17538560a11cfc88`,
without DB/Java DB downloads. It retained all severities/unfixed findings,
vulnerability and secret scans, complete report envelopes, exact ARM64 identity,
19 OS/146 Node packages, and separate legacy conversion with suppressed rows:

| Full report | SHA-256 |
| --- | --- |
| Raw, no ignore file | `8675ae7671e4d29d08183e0292137a97973f4f3026da7d7a972837be6947cef2` |
| Converted, unchanged legacy YAML | `b4451ba9a350f031091eb393b2eb734f4dc5be4f18539fc33fb3a96c90e9bed2` |

The packet contains 20 raw vulnerabilities (1 LOW, 13 MEDIUM, 6 HIGH), zero
detected secrets, and 17 visible plus 3 legacy-suppressed converted findings.
No finding is represented as fixed or clean. Fresh CI must update advisory
data and fail any unexpected blocking finding. Future digests/CVEs still need
their own explicit review; this entry grants no automatic inheritance.

The initial HIGH/CRITICAL-only diagnostic can be reproduced separately from
policy evaluation; it is not the complete policy input:

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

## Executed host checks and final-candidate gates

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

Draft PR #274's original source `99e699c593e94ec736796ac745695fb67e5addb5`
passed all five actual CI Node probes at 24.22.3 (both builders, backend
runtime, backend service and migration service). That run had 10/11 green
checks, with Security scan failing before the reviewed policy integration.

Local container execution remains unavailable because rootless Podman cannot
create namespaces; no privileged workaround was attempted. The policy
integration/follow-up preserves the pushed source through a merge, not a
history rewrite. Its final source still needs independent review, fresh
all-current CI, container/backup checks and leased integration coverage/
Chromium E2E where applicable. No DB/E2E lease is held by this worker.

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

After policy integration, those isolated checks passed again, together with
all **158 daemon-free image-policy regressions**. Replaying the retained full
raw/converted reports through the actual integrated evaluator yielded six
raw blocking matches: **3 temporary + 3 unchanged legacy, 0 rejected**.
The source Node entry was checked against the approved proposal before/after
application; globals, other images, policy code and legacy YAML are unchanged.
Logs/proofs are in the evidence directory's `policy-application/`. This replay
invoked no Trivy scan and does not replace fresh-advisory CI or final gates.

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
