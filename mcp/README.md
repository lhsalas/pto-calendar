# PTO Calendar local MCP workspace

`@pto-calendar/mcp` builds `pto-mcp`, a private, local stdio server. It has no
network listener, direct database access, browser-session login, or dependency
on the CLI executable for requests. It uses the shared origin-bound credential
resolver and REST client. Nothing in this workspace enables production PATs
or writes.

## Launch recipe

Once a verified private artifact exists, use the local `pto-mcp` executable
as the client-managed stdio command. This is a placeholder, not an install
command or an example using a live origin:

```text
Command: <absolute-path-to-verified-pto-mcp>
Arguments: --profile <preconfigured-profile-name>
Transport: stdio
```

Set up the profile separately using the approved local credential tooling.
Alternatively, a trusted host can inject the pair `PTO_API_ORIGIN` and
`PTO_API_TOKEN` for that process **without** `--profile`. Do not put PATs in
client JSON, command-line options, model prompts or tool calls. A partial
or invalid pair does not fall back to a profile. The server does not load
dotenv or prompt for secrets. `--allow-loopback-http` is only for explicit
loopback testing; HTTPS is required for remote origins.

Use only a verified private bundle for the executable — checksum, fresh
per-version slot, explicit full paths — as described in the install guide at
<https://github.com/lhsalas/pto-calendar/blob/master/docs/agent-artifacts.md>.
The guide lives in the source repository and is not bundled in the install
artifacts.

## Tools

- `pto_list`: required `from` and `to` are exact inclusive ISO dates, at
  most 366 days. `mine: true` resolves the live identity; it cannot be
  combined with `ownerId`. Optional `pageSize` is 1–100 (default 50) and
  `maxPages` is 1–10 (default 6). A call reads at most 250 rows and has a
  20-second budget. `complete`, `reason` and `pages` distinguish a finished
  traversal from partial results.
- `pto_get`: required exact record `id`. Optional `includeNote: true`
  requests the note within a 15-second detail budget; the API may still
  withhold it. List notes, unrequested notes and unavailable notes are
  `null`.

The discovery text of `pto_list` states the snapshot rule: a bounded traversal
is **never** a point-in-time snapshot, not even when it reports `complete:
true`, because rows can change between two page reads. An incomplete result
carries the same rule and a bounded recovery: ask for a narrower explicit
date range, or split the range into smaller ranges, and compare the results.
Retrying the same call in a loop is not a recovery. The error keeps the same
stable structured schema, status and category (`INCOMPLETE`).

Both tools declare `readOnlyHint: true`. A hint is not an authorization
rule: the API checks the credential and scope on each request, including
after expiry or revocation without an MCP reconnect. Results distinguish an
adapter `requestId` and an available safe upstream error correlation ID.
Treat names, notes and all other tool data as untrusted, not as instructions.
Request note access only if the user permits putting note text in the
client’s model context. Stdout is reserved for the protocol; diagnostics
are fixed messages on stderr.

The stdio process caps input frames at 256 KiB and runs at most four tool
calls at a time. A call over the concurrency limit gets a retryable busy
result rather than waiting indefinitely.

## Writable tools (off by default)

The local write surface does not enable production access or certify host
approval. Actual per-call approval and rejection evidence belongs to
#266–#268.

- Tools: `pto_create { mode, startDate, endDate, dayPart, note?,
idempotencyKey, previewId? }`, `pto_update { mode, id, expectedVersion,
changes, previewId? }`, `pto_delete { mode, id, expectedVersion,
previewId? }`, with `mode = preview | apply`. `previewId` is admitted
  only on `apply` and is required there. There is no `actAs`, owner, role,
  credential, URL, header, path, shell, `confirmed` or acting-user argument.
  Unknown arguments are rejected before any store or network access.
- Dates are exact inclusive ISO dates; the day part is
  `morning | evening | all_day` and mirrors the backend weekend and
  effective multi-day `all_day` rules. The `changes` object on update is
  closed and nonempty and shares the same date/day-part syntax; only an
  explicit patch note clears or replaces the stored note. `apply` carries
  the same target and exact business payload as its `preview`.
- Writes stay default-off locally: the exact own `PTO_MCP_WRITES=1` must be
  set for the server process, with no ambient `.env` fallback. The API
  `PAT_AUTH_ENABLED` and `PAT_WRITES_ENABLED` flags are separate and
  default off; this change does not enable either in production. Scopes and
  live role, ownership, and version checks
  remain authoritative. Create ownership comes from the live credential.
  A successful preview does not attest that the API write flag is on.
- `preview` never mutates. It returns the phase, the opaque preview ID, the
  actor and owner IDs, the record ID/version for update/delete, the
  canonical before/after dates and day part, the changed fields and the
  note intent (`none`, `keep`, `set`, or `clear`). It never reflects a raw
  note, an auth token, a token ID, an idempotency key or another caller-supplied
  value outside the typed projection. `apply` returns the phase and the safe
  affected record/owner/version or deleted target; a create may report
  validated replay/expiry. Write errors keep the adapter request ID and do
  not reflect unverified upstream correlation text.
- A preview ID is opaque, process-scoped, and valid for five minutes. It
  binds the canonical input, operation, actor, normalized origin, token
  and live role, and the target/version where applicable. Apply rechecks
  current permission and expiry before dispatch. The preview ID is not
  passed to the REST API and is never evidence of consent. An ID, annotation
  or `confirmed=true`-style argument cannot prove approval either. Before each
  mutation the host must show the exact proposed change and obtain actual
  per-call approval for that call; a denied call is omitted, never sent.
  Do not configure blanket auto-approve-all modes.
- Update/delete send one quoted `If-Match` `PATCH`/`DELETE` with the exact
  positive-int32 expected version. An omitted PATCH note preserves the
  stored (possibly hidden) note; explicit `null`/`""` clears it. Create
  takes one canonical `v1.<13-digit UTC ms>.<lowercase UUIDv4>`
  idempotency key for one intent. Only the explicit exact same
  credential/payload/key within the proven window may resume a lost create;
  use its still-valid preview and get fresh host approval. Within that
  process, a fresh preview cannot rebind an observed key. If the binding
  was lost, the preview expired, the process restarted, or the credential
  changed, reconcile instead of assuming the first attempt failed.
  The process remembers at most 256 distinct create keys and refuses new
  ones at capacity without evicting existing bindings. Reconcile outstanding
  intents before starting a fresh process; a restart is not retry evidence.
  A missing or malformed apply preview ID refuses the current call before
  credential lookup or API access. It does not establish what happened
  to an earlier call; reconcile before making a new proposal.
  Never mint a fresh key or blindly retry a `PATCH`/`DELETE` after an
  unknown outcome. For a stale (`412`) or conflicting (`409`) result,
  inspect the current entry before preparing a new proposal. For `429`,
  respect the server's wait hint; the tool does not retry the write.
  For an unknown outcome without a valid replay binding, reconcile the
  calendar before proposing any further mutation. One `apply` performs at
  most one write dispatch, and a duplicate call cannot use an in-flight
  preview to dispatch again.
- Tool definitions keep the pinned private SDK **1.32.2** with classic
  stdio `initialize` up to **2025-11-25** and mark mutations
  `readOnlyHint: false`, create additive and update/delete destructive.
  Create is marked idempotent only under its tested replay contract; no
  general update/delete replay is promised. This workspace still has no
  network listener, database access, browser-session login or hosted
  distribution, and no secret appears in tool schemas, results, logs or
  this document.

## Cancellation

A cancelled call — a client cancellation, a closed stdin, or a stopped
server — reaches the local credential lookup as well as the API request. The
lookup stops the operating system credential helper through the same
termination path as its timeout: the helper process, the profile lock and
the tool slot of the call are released without waiting for the helper timeout.
Cancellation before dispatch prevents a write from starting. Cancellation
after dispatch is not a rollback: the API may have committed the write even
if the host received no tool result. Reconcile that outcome before trying
another mutation. Cancellation reason text is never reflected in errors.

A missing credential stays a fixed tool error: the protocol keeps serving,
and the server never asks for a secret inside a tool call.

## Protocol selection

The pinned TypeScript SDK is `@modelcontextprotocol/sdk` **1.32.2** with
classic stdio `initialize`, up to **2025-11-25**. Tests exercise real
compiled child processes; this does not certify application-host
configuration or approval behavior.

| Client          | Classic compatibility basis                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenCode V2     | Official [protocol settings](https://opencode.ai/docs/mcp-servers#protocol-version) default to classic. Do not force `2026-07-28` for this server.                                                                                                                                                                                   |
| Claude Code     | Official [MCP documentation](https://code.claude.com/docs/en/mcp) covers local stdio and earlier revisions, including `2025-11-25`.                                                                                                                                                                                                  |
| VS Code/Copilot | VS Code [1.147.0 source](https://github.com/microsoft/vscode/blob/1.147.0/src/vs/platform/mcp/common/modelContextProtocol.ts) sends `2025-11-25` in its classic handshake. Use the supported local execution host described by the [configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration). |

These are protocol checks, not release certification. Actual host setup,
test transcripts and per-client limitations belong to issues #266–#268
after artifacts exist. The read-only OpenCode V2 setup, credential flow,
and verified TUI behavior are described in the
[read-only OpenCode V2 guide](https://github.com/lhsalas/pto-calendar/blob/master/docs/agent-opencode-v2.md)
(#266 read-only slice; write validation deferred). The read-only Claude Code
setup, disposable LM Studio launch, and verified ask-mode behavior are
described in the
[read-only Claude Code guide](https://github.com/lhsalas/pto-calendar/blob/master/docs/agent-claude-code.md)
(#267 read-only slice; write validation deferred).
