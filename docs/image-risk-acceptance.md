# Temporary production-image risk acceptance (#273)

**Accepted risk, NOT remediated.** Repository maintainers own this decision,
authorized on **2026-11-15**, expiring **2026-12-15 at 00:00 UTC**. Permanent
remediation [#247](https://github.com/lhsalas/pto-calendar/issues/247) stays
**OPEN**, labelled **priority:high**. Passing this policy does not mean the
images are clean, safe, patched, or runtime-validated.

## Boundary and recorded evidence

[`image-risk-acceptances.json`](../infra/security/image-risk-acceptances.json)
is the reviewed inventory. It accepts only the listed image reference
including its SHA-256 digest, advisory, package, installed version, severity,
target and literal path. No wildcard, tag-only, future-digest or future-CVE
acceptance is implied. Runtime pins, topology and the Node baseline are unchanged.

The 2026-11-15 `linux/arm64` revalidation with Trivy **0.76.2** found:

| Current image (full digest is in the manifest) | New temporary matches | Unchanged legacy matches | Raw fixable HIGH/CRITICAL |
| ---------------------------------------------- | --------------------: | -----------------------: | ------------------------: |
| Caddy `2-alpine`, `eb4d35b7452d…`              |                     5 |                        5 |                        10 |
| nginx `1.29-alpine`, `5616878291a2…`           |                    13 |                       45 |                        58 |
| Node `24.22.1-alpine`, `06d7adf3e0ef…`         |                     3 |                        3 |                         6 |
| PostgreSQL `16-alpine`, `f46107955874…`        |                    19 |                       26 |                        45 |
| **Total**                                      |                **40** |                   **79** |                   **119** |

These are package/advisory matches, not unique advisory counts. The new groups
are Caddy's brotli/curl/libcurl/go-jose/x-net, nginx's
brotli/curl/libcurl/libexpat/libxslt/musl/musl-utils/zlib, Node's npm-bundled
undici, and PostgreSQL's krb5-libs/libxslt. Every advisory and exact scope is
listed in the manifest; legacy findings remain separate.

The reviewed vulnerability DB was updated
`2026-11-15T18:56:37.733847835Z`; its `trivy.db` SHA-256 was
`e22c0a587282c1e3f3cd7f8aaded14f60d3c8bbd22ee9edb17538560a11cfc88`.
Subsequent scheduled scans use current advisory data and can find new blockers.

This is an owner decision to unblock other work pending compatible upstream
fixes, **not a finding of unreachability**. Caddy is the public TLS endpoint.
Its newly accepted x/net advisory concerns HTML-parser complexity, not HTTP/2.
The Node path is
`usr/local/lib/node_modules/npm/node_modules/undici/package.json`; this is not
Node's internal `fetch` implementation. Presence or lack of an application's
direct import does not by itself prove an advisory unreachable.

## Scan and review

```sh
node infra/security/production-images.mjs
node infra/security/scan-production-images.mjs
npm run deploy:scripts:check
```

The runner requires Trivy 0.76.2 (pinned in CI); `TRIVY_BIN` can name a local
binary. `IMAGE_SCAN_OUTPUT` can select a **fresh empty** evidence directory;
the default is ignored `security-reports/`. A nonempty directory is rejected,
not cleared or reused.

- Each enumerated image is scanned remotely on `linux/arm64`, including all
  severities, unfixed findings and secrets, with no ignore file.
- Compose enumeration accepts this repository's plain-key block mappings and
  scalar lists. Flow/JSON mappings, quoted/explicit keys, anchors/aliases, tags,
  block scalars and imported service definitions are explicitly rejected,
  never silently omitted. Convert unsupported declarations to block form or
  review parser support before using them.
- Raw `*-raw.json` and scan logs are preserved. A separate `trivy convert`
  applies the **unchanged** `.trivyignore.yaml`, retaining suppressed rows in
  `*-legacy.json`. The legacy file is SHA-256-bound in the policy; its original
  scope and expiry are not extended.
- The evaluator reconciles raw and converted findings and checks platform,
  image identity and package/target coverage. It applies the existing
  HIGH/CRITICAL-with-a-fix threshold, then exact temporary matching. HIGH/CRITICAL
  secrets remain blocking. Lower/unfixed findings remain visible, not newly
  accepted.
- `Metadata.RepoDigests` and `Reference` must identify the exact requested pin.
  The four reviewed remote reports retain that index digest; `ImageID` is the
  separate selected ARM64 configuration digest and must agree between raw and
  converted reports. It is not a second authorized image pin. Missing, malformed,
  unrelated or inconsistent digest metadata blocks.
- Supported result schemas are `os-pkgs/alpine`, `lang-pkgs/gobinary`,
  `lang-pkgs/node-pkg`, and Trivy's `secret` result with omitted `Type`.
  Unknown fields/class/type combinations and malformed array/value types block
  rather than becoming a clean result. Genuine empty findings arrays may be
  omitted (`omitempty`); unexpected/renamed findings fields may not.
- Unknown images/digests (even clean ones), unexpected findings at the blocking
  threshold, expired policy, missing/malformed reports and scanner/conversion
  failures fail the job. Individual scan failures do not stop later images.
  Enumeration errors fail rather than becoming an empty successful scan.
- `summary.json` records all temporary/legacy accepted and rejected tuples.
  `accepted-risk.md`, CI logs and the job summary say **accepted risk, NOT
  remediated**. CI always attempts to upload the `production-image-security`
  artifact, including failed-run evidence, for 30 days under existing read
  permissions. All eleven CI jobs, npm audits and coverage gates remain required.

For an offline repeat of already reviewed local evidence, share one existing
Trivy cache using `TRIVY_CACHE_DIR`; use `TRIVY_SKIP_DB_UPDATE=true` and
`TRIVY_SKIP_JAVA_DB_UPDATE=true` to prevent duplicate DB downloads. Record its
DB identity; do not confuse this repeat with a fresh-advisory check. Do not
disable updates in scheduled CI.

## Weekly upstream review and removal

Repository maintainers must review official maintained Caddy, nginx, Node and
PostgreSQL candidates **at least weekly**, alongside Monday's scheduled scan.
Record candidate digest, platform, raw findings and the review outcome in #247.
Do not rely on mutable tags, merely updated package versions, or an accepted
scan as proof of remediation.

As soon as a compatible fixed image is available, review the immutable pin,
scan all production images, run application/static/container/backup gates and
remove the obsolete temporary entries in the same PR. Do not extend legacy
exceptions. Keep #247 open/high until its permanent-remediation criteria pass.

There is **no silent renewal**: both the manifest and evaluator enforce the
first expiry. A later owner decision requires an explicit separately reviewed
policy change with rationale and a bounded deadline, never an automated refresh.

## Explicit new-digest review (#248 and later PRs)

Changing a pin deliberately blocks this policy until that PR reviews the new
digest. #273 does **not** pre-authorize Node 24.22.3 or any other replacement.
Use fresh raw/legacy scans of the candidate, retain evidence and obtain explicit
review of every additional accepted tuple before editing the manifest.

The JSON schema is:

- Global: `approvedOn`, `expiresOn`, `owner`, `issue`, `remediationIssue`,
  `legacyIgnoreSha256`, `images`.
- Each image: `image` (full tagged digest), `targets` (exact report targets that
  must have package coverage), `packages` (reviewed new acceptances).
- Each package group: `name`, `target`, `path`, `installedVersion`, `severity`,
  `advisories` (explicit CVE IDs). `path` is `PkgPath` if present, otherwise the
  exact result `Target`; it is never a glob. Package coverage must also match.

A reviewed clean replacement still needs an image/target entry, but can use
`packages: []`; it gets no vulnerability acceptance. Remove obsolete image
entries when replacing pins. Do not automatically copy old exceptions or
regenerate this manifest from whatever a scanner happens to find. Re-run the
daemon-free regressions and full gates in that PR; preserve the existing
approval/expiry rather than silently restarting the clock.
