# ADR: Personal-token CLI and local MCP delivery

**Status:** approved delivery plan; **not implemented or released by this document**.
Tracking: [#246]. Owner decisions: **2026-11-12**; approved parallel execution
plan recorded **2026-11-15**.

The [assessment](ai-agent-access-report.html) retains its **2026-11-12** source
snapshot, `fc6b7d7`. Planning verified master
`156cc6f450acfd8bc17be2412e72022b36389c0d` (one workflow-only commit later).
Neither snapshot certifies future functionality. This ADR supersedes the
assessment's illustrative ordering and open choices; issue bodies retain their
deliverable-specific acceptance criteria. Publish this contract before feature
implementation depends on it. Implementation PRs must update the
[OpenAPI specification](openapi.yaml) alongside behavior, not advertise proposed
routes as available now.

## 1. Decision and boundaries

Deliver **both a terminal CLI and a local stdio MCP server**, backed by the same
REST contracts and local credential lookup. Selected acceptance clients are
**OpenCode V2, Claude Code, and VS Code/Copilot**.

```text
Browser session ──> own-token settings / session-only /auth/tokens
                            │ one-time secret entered locally
Agent host ──> CLI or local stdio MCP ──> origin-bound credential profile
                                      + shared typed REST client
                                      ──HTTPS──> Caddy -> nginx -> Express
                                                               ├─ PostgreSQL
                                                               └─ shared Redis quotas
```

The backend remains authoritative for validation, scopes, live role/ownership,
privacy, audit and write integrity. The MCP adapter calls the shared client
directly: no database access, HTTP listener, shell-out to the CLI, or new public
port. The runtime-neutral client must not import Vite/browser globals.

**Excluded:** hosted HTTP MCP/OAuth, SSO, create-on-behalf, PTO approvals,
multi-team tenancy, new user administration, public registry publication,
automatic client configuration and automatic production deployment. Host approval
of an agent action is distinct from a PTO business approval workflow.

## 2. Shared security contract

### Personal credentials ([#249]–[#254])

- All roles (`member`, `team_lead`, `admin`) manage **only their own** tokens.
  Proposed `/settings/tokens` uses normal authenticated-user protection and an
  Account entry, not an admin/lead gate. Issuance requires a browser session and
  current password verification (or a documented short server-verified recent-auth
  window); revocation needs a valid session/CSRF protection, not a fresh password
  during an incident.
- Lifetime defaults to **90 days**, with **30/90/180/365-day** UI choices.
  Validate positive integer days; compute absolute UTC expiry server-side.
  `expiresAt - createdAt <= 365*24h` is a hard, non-configurable upper bound.
  Reject at `now >= expiresAt`; no never-expire, sliding renewal or renewal API.
- At most **10 active tokens per owner**, enforced transactionally under
  concurrent issuance. Active means unexpired, unrevoked and current credential
  version; invalidated/expired tokens do not permanently consume capacity.
- Opaque format: `pto_pat_<public-id>.<secret>`, with at least 32 cryptographically
  random secret bytes. Store only a SHA-256 digest of the secret; parse strictly
  and compare digests in constant time where applicable. Persist safe metadata
  (ID, owner, bounded name, display prefix, scopes, issued session version,
  creation/expiry/last-use/revocation timestamps), never a recoverable secret.
- Show the raw token exactly once; every management response is
  `Cache-Control: no-store`. Listings are metadata-only. The UI keeps the issued
  secret only in component memory and clears it on close/navigation/unmount.
- Revoke-one/all and password reset/setup/version invalidation apply on the next
  request across processes. Check live account/password eligibility, version,
  expiry and role every time; fail closed on DB errors, not stale validity caches.
  A user with `passwordHash: null` is ineligible.
  Demotion followed by promotion must not revive old elevated credentials.
  Normal logout is not remote PAT revocation.
- Preserve audit identifiers/history through defined metadata cleanup. Role
  changes use transactional credential invalidation; manual operational role
  changes must invalidate credentials too, without adding a role-edit UI.

### Scope vocabulary and authorization ([#250], [#251])

Scopes never replace current record authorization. Team scopes require live
`team_lead`/`admin` eligibility at issuance **and use**.

| Scope | Delegated capability / additional rule |
| --- | --- |
| `pto:read` | Shared calendar metadata and authorized detail; default token scope |
| `pto:notes:read` | Requires `pto:read` **and** existing `canViewNote`; explicit opt-in |
| `pto:create` | Create for the credential owner only; no owner-selection field |
| `pto:update:self` | Update owned records only |
| `pto:delete:self` | Delete owned records only |
| `pto:update:team` | Explicitly delegate teammate updates, subject to live role/record rules |
| `pto:delete:team` | Explicitly delegate teammate deletes, subject to live role/record rules |

Read-only is the default; notes and personal/team writes are separate opt-ins.
A lead with only self scopes cannot modify a colleague. Enforce scope **AND**
live role **AND** record authorization on every PTO handler, including legacy
PUT and new PATCH. List notes always remain `null`; detail, mutation and replay
responses disclose notes only with note scope plus `canViewNote`. Write scope
does not grant note-read access or require a client to read/merge a hidden note.

PATs are allowed only on deliberately scoped PTO routes and a safe `GET /auth/me`
identity/status view. Deny token/login/setup/logout routes, `/users`, holiday
administration and new unclassified routes. A PAT cannot mint or revoke tokens.
Reject mixed session/bearer credentials, and never fall back to cookies after
malformed/invalid bearer auth. Only a **successfully verified, cookie-free** PAT
request is exempt from cookie-specific CSRF checks; retain foreign-Origin
rejection, exact-origin browser protections and existing CORS policy.

Implemented by #251, server switches `PAT_AUTH_ENABLED` and `PAT_WRITES_ENABLED`
default off in every environment and remain disabled for production. Disabled writes cannot mutate even with minted write scopes;
local CLI/MCP write enablement cannot override server flags or authorization.

### Operational controls ([#252], [#253])

Audit PTO create/update/delete atomically with each mutation, plus token
issuance/revocation/version invalidation. Carry actor, credential type, token
public ID, target owner/entity, timestamp and request ID; client labels are
untrusted annotations, not authenticated CLI/MCP provenance. Failed/rolled-back
operations produce no success audit. Preserve history and define audit-note
retention/access; do not copy private notes into general security logs.

Keep passwords, digests, raw tokens, Authorization and sensitive nested shapes out
of logs, errors, metrics and limiter keys. Retain IP safety/failed-login limits;
add bounded pre-verification bearer-abuse limits, separate issuance/password
verification limits, and authenticated-user/verified-token quotas. Use atomic,
namespaced production Redis counters, fail closed on store failure, and preserve
probe exemptions. Document bounded tuning/NAT behavior; 429 includes correct
`Retry-After` and `X-Request-Id`.

**Settled by #253 (2026-11-18):** the address-based limiter stays the emergency
high-water (default 100 requests per 15 min per address); the failed-login
budget is unchanged (5 failed attempts per 15 min per address). The new budgets
are bounded by the environment schema and default to: 20 failed bearer
verifications per client address, charged before the credential lookup and
refunded once the secret verifies; 600 authenticated requests per verified user
and 300 per verified token per 60 s quota window; 20 token creations and 20
issuance password verifications per verified owner. The attempt controls use
their own bounded window (`RATE_LIMIT_ATTEMPT_WINDOW_MS`, default 15 min,
bounded to 1 s .. 24 h) so the legacy global and failed-login budgets keep
their behavior. The password budget is charged before the comparison and is
**not** given back, so it bounds the expensive comparisons themselves. The
issuance budgets never consume the browser login budget, an unverified
`Authorization` header is never an identity, every count and compensation is
atomic and bound to its own window, an unavailable store fails closed, and
`/health` and `/ready` stay exempt. The counters live in the production
Redis deployment under `pto:rate-limit:bearer-failure:`, `pto:rate-limit:quota-user:`,
`pto:rate-limit:quota-token:`, `pto:rate-limit:token-issuance:` and
`pto:rate-limit:token-password:`. The address high-water still binds first
with the conservative defaults, so every limiter value is an explicit operator
override in the deployment files; the operational tuning and alert thresholds
are recorded in `docs/deploy.md` §8.1.

## 3. Shared REST and compatibility contract

Entries below remain **proposed** except #250's session-only token management
and #251's deliberately scoped current PTO/identity methods, documented in
OpenAPI. The latter remain behind disabled-by-default flags, not enabled
production bearer access. Existing cookie calendar behavior stays supported;
client packages, new routes and pilot rollout remain separate gates.

| Contract | Required behavior | Deliverable |
| --- | --- | --- |
| `GET/POST /auth/tokens`, `DELETE /auth/tokens/:id`, `POST /auth/tokens/revoke-all` | Session-only for every role; session-derived owner; POST defaults to `pto:read` and returns 201 + show-once `rawToken`/safe metadata. Foreign/unknown IDs share a not-found response; repeat own revocation is harmless. | [#250] |
| `GET /auth/me` | Session User unchanged; PAT returns only `{ id, role, auth: { method, tokenId, scopes, expiresAt } }` behind disabled-by-default flags; no credential secrets | [#251] |
| `GET /pto` | Keep real ISO validation and inclusive **366-day** range cap. Filter `userId` in DB **before** limiting. Explicit opt-in paged mode (for example `format=page`) returns `items`, `nextCursor`, `hasMore`; unchanged callers retain the array response. | [#255] |
| Paged queries | Deterministic `(startDate, userId, id)` ordering, bounded page sizes, validated filter/range-bound cursors; traverse >1,000 records without silent loss. No point-in-time snapshot claim under concurrent changes. Adapters deduplicate/detect changes and report incomplete results when bounded budgets are exhausted. | [#255], [#259] |
| `PATCH /pto/:id` | Non-empty changed fields only; omitted keys preserve, `note: null` explicitly clears. Document empty-string compatibility. Validate the merged record, reject unknown fields/owner transfer. | [#256] |
| Existing `PUT /pto/:id` | Preserve [#237]: both dates still required; omitted note unchanged, `note: ""` clears, text sets. Create-note normalization is unchanged. | [#237], [#256] |
| `PUT/PATCH/DELETE /pto/:id` | Integer `version` starts at 1, returned on detail/mutations and paged summaries as needed. Require expected-version preconditions for browser **and** PAT writes; compare/write/increment/audit atomically. Browser edit/delete uses loaded detail version and handles refetch/reconfirmation, with no legacy bypass. | [#256] |
| All POST/PUT/PATCH writes | Enforce existing inclusive owner/date non-overlap at DB/transaction boundary, not only a preflight SELECT. Same-day morning/evening still conflict; different owners may overlap; continuous ranges may contain weekends but cannot start/end on weekends. | [#257] |
| `POST /pto` | PAT creates require a validated `Idempotency-Key` scoped to actor, credential and operation, bound to a canonical payload fingerprint. Persist replay/result, create and audit atomically: one record/audit for simultaneous identical retries. Cookie callers may remain key-optional. | [#258] |

**Precondition/error distinction (final proposed contract, [#256]):**

| HTTP status / code | Meaning and recovery |
| --- | --- |
| **428** | Required expected-version precondition missing; refetch/use the supported client, never bypass |
| **412 `STALE_WRITE`** | Failed `If-Match`; refetch, show a diff and obtain fresh approval rather than overwrite |
| **409 `CONFLICT`** | Business integrity conflict such as overlapping PTO |
| **409 `IDEMPOTENCY_CONFLICT`** | Same replay key used with a different payload |

The assessment's earlier “for example 409 STALE_WRITE” was illustrative, **not**
the accepted HTTP-precondition mapping. Preserve
`{ error: { code, message, details? } }` and `X-Request-Id`; adapters handle
400/401/403/404/409/412/428/429, 204, cancellation and unknown write outcomes.
Credential failures remain generic and scope failures are 403.

An overlap migration preflights existing data and required extension privileges.
It fails actionably on conflicts; it never deletes/rewrites production PTO.
Document migration/backup/restore and rollback on the settled Prisma 7 baseline.
Version checks, overlap integrity and idempotency are distinct guarantees.

Replay retention must be explicit and observable (**24 hours is a recommendation,
not a frozen value**). Recheck current credential validity, authorization and note
visibility before returning a replay; never cache a response that bypasses
revocation. Reuse one stable key for one approved intent; after timeout/retention
expiry reconcile rather than retry with a fresh key or assume failure.

### Implementation choices still to ratify in their owning PRs

Do not invent frozen values for bounded name/page/cursor sizes, cursor encoding,
exact `If-Match` wire grammar, quota windows/defaults, replay retention/cleanup,
audit-note retention, profile/env precedence, credential backends, package
versions/bin details, CLI JSON/exit-code schema or MCP protocol/SDK revision.
Owners document/test these within the constraints above, update this ADR and
OpenAPI/shared contracts before downstream use, and obtain approval for any
incompatible scope change. Missing precondition remains 428 and failed
`If-Match` remains 412 regardless of the chosen version encoding.

## 4. Adapter, distribution and client acceptance contract

- [#259]: shared `packages/api-client` uses explicit base origin and credential
  injection; HTTPS required except explicit loopback development. Normalize/bind
  origin; reject URL userinfo, cross-origin redirects, arbitrary request URLs and
  caller-supplied arbitrary headers. Use real abort/timeouts, bounded read
  retries/backoff and `Retry-After`; no generic automatic write retry.
- [#260]: shared credential/profile module (for example `packages/agent-auth`)
  prefers a supported OS store. Owner-only file fallback needs **explicit**
  acceptance, restrictive permissions/ACLs and atomic/symlink-safe handling; no
  silent plaintext downgrade. Secret entry is hidden prompt/stdin, never a token
  argument; managed env injection is not a vault. Reject ambiguous origin/profile
  overrides; do not discover arbitrary cwd `.env` files. Local removal is not
  remote revocation. Never prompt for credentials mid-tool-call.
- [#261], [#262]: `cli` provides auth set/status/local remove, list/get, human and
  stable JSON output/exit codes; data-only stdout and diagnostics on stderr.
  Writes preview exact actor/owner/ID/dates/diff, require interactive confirmation
  or explicit host-approved noninteractive `--yes`, and cancel without mutation.
  Read exact detail before update/delete; use PATCH and expected version.
  Persist stable create intent/replay state; no fuzzy/bulk delete or date guessing.
- [#263], [#264]: `mcp`/`pto-mcp` exposes `pto_list`, `pto_get`, then separately
  enabled `pto_create`, `pto_update`, `pto_delete`. Strict schemas and bounded,
  structured outputs include request IDs/completeness/recovery. Profile lookup is
  outside tool arguments; tools accept no secret, arbitrary URL/header, shell
  string, file path, `actAs` or role. Stdout is protocol-only, logs use stderr.
  Read-only annotations are hints, not access control; mark create idempotent only
  once the backend replay guarantee is tested, not general update/delete replay.
- [#265]: use pinned, versioned repository-release artifacts/npm-pack tarballs
  with checksums, content review and clean-install/bin/runtime smoke outside the
  monorepo. Discover every new workspace in lint/typecheck/test/build/coverage
  and security gates. No public npm publication/registry credentials are approved.
- A PAT grants **authority, not human consent**. `--yes`, annotations,
  `confirmed=true`, server trust and a plausible chat answer do not demonstrate
  per-call approval. Treat notes/names/tool results as untrusted private data, not
  instructions. Never put credentials in model context, tracked client config,
  shell history, logs, localStorage or frontend `VITE_*` variables.

### Selected clients: planned, not yet certified

| Deliverable | Required acceptance emphasis | Current official guidance |
| --- | --- | --- |
| [#266] OpenCode **V2** (CLI + MCP) | User/global setup with native `mcp.servers`; record actual classic `initialize` versus newer negotiation. Prove underlying write approval in advertised Code Mode/direct-tool mode; if unproven keep that mode read-only. | [MCP servers](https://opencode.ai/docs/mcp-servers) |
| [#267] **Claude Code** (CLI + MCP, not Claude Desktop) | User-scoped local stdio setup; verify command/argument separation, server trust and per-tool approve/reject. No raw PAT in `--env`, skip-permissions or blanket project/write approval. | [MCP](https://code.claude.com/docs/en/mcp), [settings](https://code.claude.com/docs/en/settings-reference) |
| [#268] **VS Code/Copilot** MCP | Current Copilot harness/personal configuration destination; identify execution host for desktop/SSH/container. Do not freeze deprecated Local-harness assumptions or claim untested web/remote support. | [MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |

Guidance checked **2026-11-15** (Claude Code via Context7; OpenCode/VS Code from
official docs). This ADR intentionally supplies **links, not untested configuration
or install snippets**. [Official MCP documentation](https://modelcontextprotocol.io/)
guides SDK/protocol selection in [#263]; the assessment's 2026 revision is not a
universal compatibility requirement. Recheck current docs when each client story
is implemented; publish only tested secret-free profile references.

Each client story uses packed artifacts and disposable users/profiles, records
exact client/extension/SDK/protocol/Node/OS/credential-backend versions and
configuration scope/host, and captures actual query/CRUD tool calls plus
approve/reject evidence (rejection means **no write**). Test read-only denial,
private-note opt-in, expiry/revocation on the next call without reconnect/login,
stale-write recovery, missing-token/reconnect and secret-free transcripts/logs.
Record unsupported combinations honestly and a manual permission-UI checklist
where automation is unavailable. Do not change real developer client settings.

## 5. Ordered backlog and approved parallel execution

Prerequisites mean **delivered/merged**, not merely an issue closed or a branch
started. A documented deferral/supersession needs explicit owner approval and does
not count as delivered work. No silent exception clears the backlog-first gate.

### Baseline repair and every pre-existing issue

**Owner decision — 2026-11-15:** the
[dated authorization](https://github.com/lhsalas/pto-calendar/issues/246#issuecomment-6901267341)
supersedes the earlier investigation-only/no-new-exception boundary **only** for
[#273]'s temporary acceptance of reviewed production-image findings. This dated
authorization is risk acceptance, not remediation or a **raw-clean** scan;
delivered status is recorded below.

[#273] is a separate policy-only deliverable: exact current image digest,
advisory and affected package/path, maintainer ownership and owner-accepted risk,
with first expiry/review **2026-12-15 at 00:00 UTC**, no silent renewal or inherited
acceptance for a new digest. Retain every linux/arm64 image scan, unfiltered raw
reports, visible accepted-risk summaries and aggregate results across all images.
Scanner/enumeration errors and unmatched advisories/packages/paths/digests remain
blocking; no blanket bypass, optional security job or global severity reduction.
npm audit, coverage, immutable pins and all current 11 CI checks remain unchanged.

Keep permanent remediation [#247] **OPEN, priority:high** until compatible fixed
upstream images are validated and temporary acceptances removed; review maintained
official candidates at least weekly and after security rebuild announcements.
#247's open status does not independently block unrelated merges when all current
CI passes under the accepted policy.

**Delivered baseline checkpoint — 2026-11-15:** [#273] landed via
[PR #276](https://github.com/lhsalas/pto-calendar/pull/276) at master
[`ada8e0b`](https://github.com/lhsalas/pto-calendar/commit/ada8e0ba61d20bdc4a27cb6d06c314b3bd71b15e).
The coordinator verified all 11 policy-PR and master CI checks green; this is not
validation of the refreshed #246 candidate. The
[landed runbook](image-risk-acceptance.md) records **40 temporary + 79 legacy
matches**: accepted risk, not clean images.
**Current integration checkpoint — 2026-11-15:** master
[`2a4ed0f`](https://github.com/lhsalas/pto-calendar/commit/2a4ed0f8b01a22a9620420732e791e00b92a3f0a)
also includes #235 via [PR #272](https://github.com/lhsalas/pto-calendar/pull/272)
and #248 via [PR #274](https://github.com/lhsalas/pto-calendar/pull/274), with the
Node 24.22.3 baseline retained. #227 is pending in draft PR #275; #236 is under
implementation, not merged; #237 and the other original backlog issues remain
pending. All 11 original deliverables (including delivered #235) plus #270 still
precede token work; token/API/CLI/MCP features remain proposals.

The current baseline lane is **#273 -> #248**. #248 aligns Node 24
runtime/image/engine pins; each new digest needs a fresh raw scan and explicit
review, not automatic inheritance of #273 acceptance. No new registry/builder
infrastructure, permissions, publication or deployment is authorized. Reconcile
PRs #241/#244 under #248, #240 under #231, and review/rebase grouped #245 on the
validated baseline; this plan does not merge or close them.

The complete **serial reference order** for all 11 original open issues is:

| Position | Issue | Deliverable / dependency distinction |
| --- | --- | --- |
| 1 | [#235] | Explicit unknown/loaded-empty/text note state; one successful load per opening, failed loads may retry |
| 2 | [#236] | Uses #235; load actual detail note before edit, block failed/unknown edit, always send note key (`""` intentionally clears) |
| 3 | [#237] | Follows #235/#236; omitted PUT note preserves, empty clears, text replaces; not general PATCH |
| 4 | [#227] | Align Vitest 5/coverage provider to one version |
| 5 | [#228] | Migrate MSW mocks, preserving query assertions |
| 6 | [#230] | Supported TypeScript 6 line; keep >=7 blocked unless owner approves changed scope |
| 7 | [#229] | Express 5/body-parser 2 together |
| 8 | [#231] | Limiter/Redis store together; technically independent of Express migration |
| 9 | [#234] | Prisma 7 configuration/driver construction, including test/seed/deploy paths |
| 10 | [#233] | React 19, explicit JSX/ref types, one runtime |
| 11 | [#232] | ESLint 10/Hooks rules on corrected components; no disabled rules or routine lockfile deletion |

The migration order reduces lockfile/harness/component churn, not a claim of
intrinsic library dependencies. Revalidate historical 2026-10-23 version/API claims
against current official docs in each story. Preserve all three note regressions.

**Hard scheduling gate:** all **11** above must be delivered on master with
current CI green, plus the validated #273/#248 baseline and published contract,
**before any new agent feature implementation (#249 onward)**. Documentation and
operational prerequisites are not an exception to this rule.

**Additional baseline prerequisite [#270] (2026-11-15):** the coordinator
reproduced a direct backend unit coverage failure on unchanged master `156cc6f`,
not a #235/#246 regression. All 269 unit tests pass, but declared critical-path
100% thresholds fail; CI currently runs backend units without coverage (frontend
CI does run coverage). See [baseline evidence](testing-strategy.md#5-coverage-targets).
Revalidate after #227, then deliver #270 after the original backlog and before
#249/#251 token implementation; it is not a twelfth original backlog issue.
The image-only risk acceptance above does not waive #270 or change coverage policy.

**Feature prerequisite checkpoint — 2026-11-16:** all eleven original issues
and #270 are delivered on master `c4233a5d86f633f7ca47861d27b169752d122431`;
master CI run `43986788679` passed all eleven jobs. #249 is the first foundation
implementation candidate, not yet reviewed or delivered. The earlier
checkpoint above is preserved as dated history. #247 remains open/high priority;
the temporary image-risk acceptance is not remediation.

### Feature order, with explicit prerequisites

**Scoped-auth checkpoint — 2026-11-17:** #250 was delivered by PR292 on master
`25db78bc0a3225158a7faf2f20eccd3ce06ff79d`; post-merge CI run `44116608988`
passed all eleven jobs. #251 implements the typed auth context, strict
cookie/PAT selection, explicit route allowlist, scope/role/owner checks,
note redaction and off-by-default rollout flags. This is implementation scope,
not authorization to enable production access or a claim that audit, quotas,
query integrity, clients or pilot gates have passed.

**Foundation checkpoint — 2026-11-17:** #249 was delivered by PR291 on master
`b386bf7d7994a336278a35e65dd66be3ecdac13e`; post-merge CI run `44105460188`
passed all eleven jobs. #250 adds the session-only management contract below,
not a token settings UI or PTO bearer access. #251, lifecycle auditing/quotas
and the separate pilot/production gates remain outstanding; the dated earlier
checkpoint is retained rather than rewritten as historical certification.

**Audit checkpoint — 2026-11-17:** #251 was delivered by PR293 on master
`82cfc73538259c405608f0e5b870a0c52865b93c`. #252 is the next candidate in the
operational-controls wave. At this checkpoint it was not yet accepted or
published, and it adds no public audit browsing endpoint or UI — the trail
stays internal. Its scope is the audit half of this section only (atomic,
credential-attributed rows for PTO and credential-lifecycle changes, and
credential-safe logging); the quota half remains #253. The dated earlier
checkpoints are retained rather than rewritten as historical certification.

**Quota checkpoint — 2026-11-18:** #252 was delivered by PR295 on master
`f83003ac68e27d44b2c4ad4c53d6845fc1d17ac7`. #253 implements the quota half of
the operational-controls section: the address-based limiter stays the emergency
high-water, a failed bearer verification is charged **before** the credential
lookup and refunded once the secret verifies, every authenticated request is
charged once against the **verified** user and the verified token, and token
creation and the issuance password check have separate per-owner budgets that
never consume the browser login budget. The counters are namespaced shared
Redis counters that fail closed; the operational probes stay exempt; the
tuning table and the alert signals are recorded in `docs/deploy.md` §8.1 and
the contract in `docs/technical-spec.md` §10.6. This is implementation scope
only: it is not authorization to enable production bearer access, not a
statement about the real-Redis certification of a production deployment, and
not a claim that the client, pilot or rollout gates have passed.

Rows give the safe serial default. Parallel development is restricted to the
approved waves below after prerequisites merge; every row is one deliverable/PR.

| Order | Issue / deliverable | Prerequisites |
| --- | --- | --- |
| 1 | [#249] PAT persistence/invalidation | Entire backlog gate above (settled Prisma #234), plus #270 |
| 2 | [#250] Session-only token APIs | #249 |
| 3 | [#251] Scoped PAT authentication | #250, #270 |
| 4 | [#252] Credential-attributed lifecycle/PTO audit | #251 |
| 5 | [#253] Issuance and agent quotas | #251 |
| 6 | [#254] All-role own-token settings UI | #250, #252, #253 |
| 7 | [#255] Owner filter/complete paged queries | #251 |
| 8 | [#256] Versioned PUT/PATCH/delete + browser update | #255, #252 |
| 9 | [#257] Atomic overlap integrity | #256 |
| 10 | [#258] Idempotent create | #257, #252 |
| 11 | [#259] Shared typed REST client | #258, #253 |
| 12 | [#260] Origin-bound local credentials | #259 |
| 13 | [#261] Read-only CLI | #260, #254 |
| 14 | [#262] Confirmed CLI writes | #261 |
| 15 | [#263] Read-only local stdio MCP | #261 |
| 16 | [#264] Scoped consent-aware MCP writes | #263, #262 |
| 17 | [#265] Versioned packed artifacts | #262, #264 |
| 18 | [#266] OpenCode acceptance | #265 |
| 19 | [#267] Claude Code acceptance | #265 |
| 20 | [#268] VS Code/Copilot acceptance | #265 |
| 21 | [#269] Staged operational acceptance/rollout | #266, #267, #268 |

### Approved waves and ownership rules

1. Initial wave: **#247 infrastructure**, **#235 frontend**, and **#246
   documentation** in separate worktrees. The later **2026-11-15 owner decision**
   preserves #247 WIP and replaces the blocking infrastructure lane with
   **#273 -> #248**, alongside **#235 -> #236 -> #237**. Merges still require all
   current CI green under the explicitly accepted policy, not permanent #247
   closure.
2. Run **#227 -> #228 -> #230 -> #229 -> #231 -> #234 -> #233 -> #232** as one
   serial dependency/lockfile integration lane, after the note lane/baseline.
   Revalidate #270 after #227; complete #270 after the entire original
   backlog/CI gate and before scheduling feature work.
3. Serial foundation **#249 -> #250 -> #251**.
4. Parallel **#252 audit / #253 quotas / #255 queries**. Once #252+#253 merge,
   **#254 UI** may overlap **#256 -> #257 -> #258** (the integrity chain waits
   for #255+#252). Coordinate shared schema/audit/docs files rather than assume
   these lanes cannot conflict.
5. **#259 -> #260 -> #261**, with #261 also waiting for #254.
6. Parallel **#262 CLI writes / #263 MCP reads**; **#264** waits for both.
7. **#265 packaging**; then parallel **#266 / #267 / #268** real-client
   acceptance; finally **#269** controlled rollout with explicit production
   approval.

Maximum **3 implementation workers + 1 independent reviewer**. The main
orchestrator is the **sole merge authority**; workers do not push/create PRs
until coordinated local gates and independent review, and never merge/deploy.
This plan records the approved delegation boundary, not permission for workers
to spawn more agents.

Each worker creates a fresh issue-specific worktree/branch from the
orchestrator-approved **current master SHA**, records base/head/files/checks and
hands back blockers. Do not take over master checked out elsewhere or edit
another lane. Inspect existing worktrees/branches and user changes; report
collisions, never reset/overwrite/discard them. Serialize shared lockfile/schema
integration and regenerate/test against merged prerequisites before acceptance.
Use Conventional Commits with `Closes #<issue>` and the repository PR template.

**Worktree isolation is not DB/port/container isolation.** No parallel worker may
start/reset services, migrate/truncate shared databases, run destructive
integration/E2E/Docker gates, or tear down containers without an **exclusive
disposable-test lease** from the coordinator. Record holder, worktree/commit,
explicit non-production DB/ports/container/volume names, permitted reset scope
and release/cleanup. Verify the effective target, not a default `.env` or script
fallback; never truncate production or another lane. Formatting/static/unit
checks without shared services may run independently.

## 6. Acceptance, release gates and roadmap maintenance

**Every PR, before push:** lint/typecheck/unit tests in both existing workspaces;
backend `test:integration:coverage` on disposable `pto_test` with **All files
lines >=90%**; frontend build; **100% green** desktop Chromium E2E with
`--project=chromium --workers=1` and the designated non-production reset procedure
under the lease above. Extend equivalent checks to every new workspace. Preserve
all per-path floors; new auth/authorization/scope/validation code requires **100%
unit coverage across metrics**; other new agent packages target **>=90%
lines/statements/functions and >=80% branches**.

Require **all current 11 CI checks**, not the stale eight-job count in older
instructions: lint, typecheck, backend unit, backend integration, frontend tests,
build, deployment config, security scan, E2E, Docker smoke and coverage gate
([current workflow](../.github/workflows/ci.yml)). Any later required checks also
apply. No threshold reductions, scan bypasses, broad suppressions or unrelated
upgrades. Independent review checks exact diff/PR file list and acceptance
evidence; sole merge authority remains with the orchestrator.

**[#269] go/no-go (not deployment permission):**

- Exercise staging/disposable accounts through **HTTPS -> Caddy -> nginx ->
  Express -> PostgreSQL**, with shared Redis: Authorization forwarding, no-store,
  role/scope/note privacy, immediate reset/revoke/demotion, quotas and safe logs.
- Implemented `PAT_AUTH_ENABLED` and `PAT_WRITES_ENABLED` default **false** for
  production. After UI/auth/audit/quotas/complete-query gates pass, enable only an
  explicitly approved **read-only pilot**; verify both adapters cannot write.
- Personal writes require version/precondition, overlap, idempotency/audit,
  packaging and **all three actual-client consent checks**. Team scopes remain
  explicit lead/admin opt-in, not default escalation.
- Record dated commit/artifact/client versions, test evidence, alerts/metrics,
  expiry/replacement/revocation instructions, AI-provider note policy and
  maintainer go/no-go. Production verification is read-only unless the maintainer
  explicitly approves disposable test-account mutations; planning approves no
  live flags, real token creation, client config writes, publication or deploy.
- Roll back by disabling PAT writes/auth while preserving cookie calendar/login,
  PTO/audit/token data and expiry/revocation rules, not by dropping tables.

**Maintenance rule:** each merge, explicit owner-approved deferral or
supersession updates this roadmap and the issue dependency/status evidence in the
same scoped delivery. Record issue, deliverable, merged PR/commit, exact gate
evidence/date and remaining blockers; do not mark a box delivered just because
an issue was closed. Keep status in [#246] until delivery and the owning issues
thereafter; this dated planning snapshot intentionally claims **no feature
completion**. Scope/contract changes update the ADR, issue bodies, assessment
proposal addendum and affected README/API/testing/deployment docs together.

[#227]: https://github.com/lhsalas/pto-calendar/issues/227
[#228]: https://github.com/lhsalas/pto-calendar/issues/228
[#229]: https://github.com/lhsalas/pto-calendar/issues/229
[#230]: https://github.com/lhsalas/pto-calendar/issues/230
[#231]: https://github.com/lhsalas/pto-calendar/issues/231
[#232]: https://github.com/lhsalas/pto-calendar/issues/232
[#233]: https://github.com/lhsalas/pto-calendar/issues/233
[#234]: https://github.com/lhsalas/pto-calendar/issues/234
[#235]: https://github.com/lhsalas/pto-calendar/issues/235
[#236]: https://github.com/lhsalas/pto-calendar/issues/236
[#237]: https://github.com/lhsalas/pto-calendar/issues/237
[#246]: https://github.com/lhsalas/pto-calendar/issues/246
[#247]: https://github.com/lhsalas/pto-calendar/issues/247
[#248]: https://github.com/lhsalas/pto-calendar/issues/248
[#249]: https://github.com/lhsalas/pto-calendar/issues/249
[#250]: https://github.com/lhsalas/pto-calendar/issues/250
[#251]: https://github.com/lhsalas/pto-calendar/issues/251
[#252]: https://github.com/lhsalas/pto-calendar/issues/252
[#253]: https://github.com/lhsalas/pto-calendar/issues/253
[#254]: https://github.com/lhsalas/pto-calendar/issues/254
[#255]: https://github.com/lhsalas/pto-calendar/issues/255
[#256]: https://github.com/lhsalas/pto-calendar/issues/256
[#257]: https://github.com/lhsalas/pto-calendar/issues/257
[#258]: https://github.com/lhsalas/pto-calendar/issues/258
[#259]: https://github.com/lhsalas/pto-calendar/issues/259
[#260]: https://github.com/lhsalas/pto-calendar/issues/260
[#261]: https://github.com/lhsalas/pto-calendar/issues/261
[#262]: https://github.com/lhsalas/pto-calendar/issues/262
[#263]: https://github.com/lhsalas/pto-calendar/issues/263
[#264]: https://github.com/lhsalas/pto-calendar/issues/264
[#265]: https://github.com/lhsalas/pto-calendar/issues/265
[#266]: https://github.com/lhsalas/pto-calendar/issues/266
[#267]: https://github.com/lhsalas/pto-calendar/issues/267
[#268]: https://github.com/lhsalas/pto-calendar/issues/268
[#269]: https://github.com/lhsalas/pto-calendar/issues/269
[#270]: https://github.com/lhsalas/pto-calendar/issues/270
[#273]: https://github.com/lhsalas/pto-calendar/issues/273
