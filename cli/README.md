# `@pto-calendar/cli`

Terminal client for the PTO Calendar API. This is a private workspace for the
CLI stages of the personal-token work. Read commands are available; `create`,
`update` and `delete` are implemented behind the explicit local and service
write gates described in [Writable commands](#writable-commands). No part of
this workspace publishes an npm artifact, provides a global install, ships a
container image or starts a hosted service. Build and run it from this
checkout, and use only disposable test data and reserved placeholder origins.

The CLI exposes help, version, credential setup/status/removal, `list`, `get`,
`create`, `update` and `delete`. A missing scope, a disabled service gate or a
missing local write switch is refused with a fixed safe failure; the CLI never
mints, broadens or substitutes a token.

## Requirements and build

The workspace targets the repository Node.js baseline, `>=24.22.3`. The local
credential layer defaults to the validated keyring backend and never downgrades
to a file by itself; `--storage file` is an explicit plaintext opt-in.
Persistent profiles use the supported Linux backends documented in
[`packages/agent-auth`](../packages/agent-auth/README.md).

Build the local workspaces in dependency order:

```sh
npm ci
npm run build -w packages/api-client
npm run build -w packages/agent-auth
npm run build -w cli
```

Run the local executable as `node cli/bin/pto.mjs <command>`. The examples
below use `pto` for brevity. Do not publish or redistribute this workspace
as an npm package.

For versioned use outside this checkout, install only a verified private
bundle into a fresh per-version slot; see the install guide at
<https://github.com/lhsalas/pto-calendar/blob/master/docs/agent-artifacts.md>.
The guide lives in the source repository and is not bundled in the install
artifacts. Never use `npx <package>@latest` as the setup.

## Commands

| Command           | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `pto help`        | Show fixed help; also `pto`, `pto --help` and `pto -h`.   |
| `pto version`     | Print the package version; also `pto --version`.          |
| `pto auth set`    | Store one origin-bound credential in a local profile.     |
| `pto auth status` | Verify the selected credential with `GET /auth/me`.       |
| `pto auth remove` | Remove the local credential without revoking it remotely. |
| `pto list`        | Read PTO records for an explicit inclusive date range.    |
| `pto get`         | Read one PTO record by canonical UUID.                    |
| `pto create`      | Create one PTO owned by the token holder; write gate.     |
| `pto update`      | Partially update one record with an exact version.        |
| `pto delete`      | Delete one record with an exact version.                  |

Add `--json` once, before or after the command and before or after its flags,
to request the stable machine format. Without it, output is human readable.
Result data goes to stdout; diagnostics, previews and prompts go to stderr.

Use one `--flag value` or `--flag=value` spelling per string option. Boolean
flags take no value. Repeated flags, unknown flags, the `--` separator and
short flags other than `-h` are rejected before any store, prompt or network
access. Invalid commands, profile names, origins, dates, UUIDs, versions,
write values and pagination values are rejected the same way.

Help and version are offline: they read no profile store, environment
credential, stdin or network, and they accept no setup, read or write flags.
Only explicit `auth set` asks for a credential; reads never prompt. A write may
print a preview and ask for confirmation, as described below.

### Auth setup

```sh
pto auth set --origin https://pto.example.com
pto auth set --origin https://pto.example.com --profile work
pto auth set --origin https://pto.example.com --profile local --storage file
```

`pto.example.com` is a reserved placeholder, not a real PTO host. Every
non-secret argument is validated before the token is read. When both stdin and
stderr are terminals, setup prints a fixed prompt label on stderr and reads the
token with hidden input. For non-interactive setup, pass `--token-stdin` and
supply one newline-terminated line on stdin followed by EOF; the token is never
accepted in argv and never appears in this README.

- `--profile <name>` defaults to `default`. Names are stable local labels, not
  secrets.
- `--storage keyring` is the default. A locked, missing, ambiguous or
  unavailable keyring fails closed; setup does not fall back to plaintext.
- `--storage file` is an explicit plaintext opt-in in the owner-only local
  store. Prefer the keyring. Owner processes and backups may be able to read
  the file.
- `--allow-loopback-http` is required for plain HTTP. Only the literal hosts
  `localhost`, `127.0.0.1` and `[::1]` are permitted.

### Auth status

```sh
pto auth status
pto auth status --profile work --origin https://pto.example.com
pto auth status --json
```

`auth status` resolves the selected credential once, uses `GET /auth/me` to
verify it, and reports only the profile, origin, source, owner UUID,
scopes and expiry. `source` is one of `keyring`, `file` or `environment`. The
command makes a network request; it is not a purely local presence report.

If the service rejects the credential as unauthenticated, revoked or expired,
the command exits with the authentication code and fixed guidance explains how
to replace or revoke the token in the signed-in browser UI. It never opens a
browser, prints a token or token digest, or asks for a token during a read.

### Local removal

```sh
pto auth remove --profile work
```

`auth remove` deletes the local profile credential only. It is not a remote
revocation. If the server must stop accepting the token, revoke or replace it
in the signed-in browser UI.

### List

```sh
pto list --from 2026-12-01 --to 2026-12-31 --mine
pto list --from 2026-12-01 --to 2026-12-31 \
  --owner 11111111-1111-4111-8111-111111111111 --json
pto list --from 2026-11-01 --to 2026-12-31 \
  --page-size 50 --max-pages 5 --json
```

- `--from` and `--to` are required real calendar dates in `YYYY-MM-DD` form.
  The range is inclusive, must be ordered, and may span at most 366 days.
  Natural-language dates are not accepted.
- `--mine` derives the owner id from `/auth/me`. `--owner` accepts a canonical
  UUID. The filters are optional and mutually exclusive; without either one,
  every record visible to the credential is requested.
- `--page-size` defaults to 100 and accepts 1 through 200.
- `--max-pages` defaults to 30 and accepts 1 through 30.
- One traversal is capped at 5000 records and 30 seconds of total API budget,
  including the `--mine` identity read. `get` and `auth status` use a
  15-second budget.

Paged reads are not a snapshot: records may change between pages. If pages are
left unread because of a page or time budget, a deadline, drift, an invalid
response or an error, the result never claims a complete snapshot: it reports
incomplete with a reason, page count and any partial rows, unless no rows were
read and a specific API failure is retained instead. Cancellation takes
precedence and exits 130. Partial rows are not an absence of records and are
not a complete result. Reads use propagated cancellation, bounded GET retries
that honor `Retry-After`, and no adapter-level retries.

### Get

```sh
pto get 11111111-1111-4111-8111-111111111111
pto get 11111111-1111-4111-8111-111111111111 \
  --origin https://pto.example.com --json
```

`get` accepts one canonical UUID. It renders a note only when the server
actually returned that note for this credential; it never fabricates an
ungranted note. `list` and `get` require an authorized read scope.

## Writable commands

Writes are off by default at the local CLI and at the service. They are gated
local CLI behavior, not a production rollout, and no layer can widen another
layer's decision.

All three commands accept `--yes`, `--profile`, `--origin`,
`--allow-loopback-http` and `--json`. They accept no owner, user, path, URL,
arbitrary-header, role or secret option. Each command maps to exactly one
scoped REST operation: create to `POST /pto`, update to `PATCH /pto/:id` and
delete to `DELETE /pto/:id`. There is no legacy unversioned mutation fallback.

### Enabling writes

The trusted host environment must explicitly set `PTO_CLI_WRITES=1` for the
run. This is a local switch, not a credential. It is never read from a `.env`
file, a profile or a configuration default, and `--yes` does not imply it.
Without it, a write command refuses to write even when every other condition
is satisfied.

The service independently enforces its own gates. `PAT_AUTH_ENABLED` and
`PAT_WRITES_ENABLED` both default to `false` in every environment, and write
traffic stays disabled for production. Even when both flags and the local
switch allow a run, a write needs the matching scope, a live role and record
authorization:

| Command  | Required scope    | Owner rule                                                    |
| -------- | ----------------- | ------------------------------------------------------------- |
| `create` | `pto:create`      | Always the live token holder; no owner option.                |
| `update` | `pto:update:self` | Only a record owned by the token holder.                      |
| `update` | `pto:update:team` | A teammate record, with live team-lead or administrator role. |
| `delete` | `pto:delete:self` | Only a record owned by the token holder.                      |
| `delete` | `pto:delete:team` | A teammate record, with live team-lead or administrator role. |

A self-only lead token cannot mutate a teammate. Note reading is a separate
opt-in: `pto:notes:read` plus `canViewNote`. A write scope never grants note
access, and a hidden note is preserved when the CLI omits it. The default token
remains read-only, and the CLI never automatically adds a scope or expands a
read-only token. Update and delete also need `pto:read` to load the exact
record before dispatch.

### Create

```sh
pto create --from 2026-12-07 --to 2026-12-07 --day-part morning \
  --note "placeholder note"
pto create --from 2026-12-14 --to 2026-12-18 --day-part all_day \
  --operation 33333333-3333-4333-8333-333333333333 --json
```

`create` makes one record for the token holder. There is no owner, user, path
or URL option: the live `/auth/me` actor is the owner. `--from`, `--to` and
`--day-part` are required. The day part is one of `morning`, `evening` and
`all_day`; a multi-day range is stored by the service as `all_day`. The dates
must be real ISO dates, ordered, may span at most 366 days, and must not start
or end on a Saturday or Sunday. Natural-language dates are rejected. The CLI
never substitutes a date or moves an endpoint to a weekday. `--note` is
optional and accepts at most 500 characters.

The result exposes a safe operation UUIDv4. Keep it for reconciliation; it is
a public identifier, separate from the private idempotency key. `--operation`
supplies an existing pending operation for an explicit same-input resume (see
[Pending creates](#pending-creates)). Every create is subject to
[Write confirmation](#write-confirmation).

### Update

```sh
pto update 11111111-1111-4111-8111-111111111111 --version 3 \
  --from 2026-12-07 --to 2026-12-07 --day-part evening
pto update 11111111-1111-4111-8111-111111111111 --version 3 --clear-note
pto update 11111111-1111-4111-8111-111111111111 --version 3 \
  --note "placeholder note" --json
```

`update` changes one exact record by canonical UUID and sends a `PATCH` that
carries only the named fields. Fields that are not named are preserved, so an
omitted note, date or day part is never cleared by the update. `--version` is
required and accepts a positive int32 in `1..2147483647`. At least one of
`--from`, `--to`, `--day-part`, `--note` or `--clear-note` is required;
`--note` and `--clear-note` cannot be combined. If both dates are named, the
same ordered, weekday and 366-day rules apply. The CLI reads the exact target
detail first, compares the explicit expected version with the loaded version,
and refuses a stale or malformed value before dispatch. The owner can never be
transferred.

### Delete

```sh
pto delete 11111111-1111-4111-8111-111111111111 --version 3
pto delete 11111111-1111-4111-8111-111111111111 --version 3 --json
```

`delete` removes one exact record by canonical UUID after reading its detail
and sending a single versioned `DELETE`. `--version` is required and accepts a
positive int32 in `1..2147483647`. There is no wildcard, fuzzy match or bulk
delete. A stale or malformed version is refused before dispatch, so a stale
delete never removes a newer revision.

### Write confirmation

When stdin and stderr are both terminals, every write prints a preview on
stderr before dispatch and asks for the exact word `yes`, even when `--yes`
was passed. Any other answer, EOF, cancellation or a signal performs no write.
When stdin is not a terminal, the CLI does not prompt: it refuses without
`--yes` and proceeds with it. When stdin is a terminal but stderr is not, the
write is refused with a usage error before any credential is read and before
any request is sent, even when `--yes` was passed, because the preview could
not be shown to the user. In every case `--yes` is a local acknowledgement
only.
The service has no server-verifiable human-consent proof, so the CLI never
treats `--yes` as server consent or as an approval token.

The preview names the safe origin, the live `/auth/me` actor UUID, the exact
target owner UUID and record UUID (a create has no record UUID yet), the exact
ISO dates and day part, the current record version for update and delete, and
the named fields being changed. Note handling is shown as keep, set, clear or
none; private note text is not shown.

An agent invoking the CLI must show the proposed operation to its user and
obtain the user's approval before passing `--yes` in a non-interactive
workflow. Passing `--yes` because the flag exists is not user approval.

### Pending creates

For each approved create intent, the CLI generates one idempotency key and
keeps it in a private owner-only local pending record bound to the live origin
and actor. The key is not the public operation UUID and is never printed. The
record is independent of the profile name and token, so switching tokens
cannot mint a new key while the operation is pending. The raw token and note
text are not stored in it.

The key is valid only for the service's original 24-hour window. If a create's
answer is lost, whether by timeout, dropped connection or another ambiguous
outcome, the CLI does not call the write failed and does not retry with a new
key. It reports `create-pending` with the safe operation UUIDv4 and expiry, and a
second plain `create` while the pending record exists does not dispatch.

To resume before expiry, repeat the same approved create fields with
`--operation <operation-uuid>`. The CLI verifies the same origin, live actor,
credential public ID and normalized payload, applies the same confirmation
rule, and performs at most one write. A successful server replay returns the
original safe result with `replayed: true` and makes no second change. A
different payload, origin, actor or credential is refused, and nothing is
replayed silently. Malformed, mismatched, expired or unavailable pending state
also fails closed. A verified success clears the pending record only after
the CLI delivers the result to stdout. A fresh attempt with a definite
no-write result may also clear it. A broken output stream, ambiguous result,
or unsuccessful resume does not.

On Linux the pending state is written through directory descriptors that never
follow a symbolic link, and it is made durable before anything is dispatched.
The pending record is staged, flushed, linked into the journal without
overwriting anything, and the journal directory is flushed afterwards. Every
directory on the path from the root to the journal is flushed in its own parent
while that parent is still open, so the name of a new journal directory is
durable before the journal is used. That holds for a directory this run
created, for one another process created first, and for one that an earlier
interrupted run left behind: an existing name is never treated as durability
proof. A resumed operation flushes the journal directory again under the owner
lock before it dispatches, because a prior publication may have linked the
record and then been interrupted before that directory was flushed. The
resumed operation keeps the same operation identifier and the same key. If a
required flush is unsupported or fails, the CLI reports a local journal
failure, sends no create request and does not remove any pending record. If
the final journal flush fails during resume, the error reports the known
pending operation so the next approved attempt can use the same identifier.

After the deadline or a token replacement, recovery is manual. Do not invent a
new key or assume the create failed. Reconcile the live records and the audit
trail with a separate read, make sure no other CLI invocation is running, then
privately archive the preserved pending state. The CLI has no automatic
unlock, key rotation, state deletion or fresh-key fallback. The pending guard
covers this host only: it cannot coordinate another device, so the service's
overlap rule and idempotency window remain the final guards. On Linux the
owner-only state directory is `$HOME/.local/state/pto-calendar/create-intents`.
Do not print, inspect in chat, or hand-edit its files: the replay key is private.
If you cannot identify the preserved state safely, leave it untouched and ask
the local administrator to help reconcile it.

### Unknown and conflict outcomes

An `update` or `delete` whose request was dispatched but whose answer was lost
is reported as `outcome-unknown` with the target UUID and expected version. It
is never reported as failed, cancelled or applied when the CLI cannot know
that. Re-read the exact record before deciding on another attempt; the CLI
does not retry the write automatically.

An overlap or other `409` is a conflict. The CLI performs no automatic repair,
and the user must choose different dates or reconcile the existing record. A
`404`, `403` or version failure keeps its own fixed classification and safe
request id; no raw response body, token, note or key is shown.

A `412 STALE_WRITE` means someone changed the record after it was read. The
CLI refetches once with a bounded read, reports the approved baseline next to
the current safe fields (or a non-invented unavailable result), and requires a
fresh preview and confirmation with the new version. It never silently
overwrites the newer revision and never retries the stale write.

### Notes

`update` preserves the stored note when `--note` and `--clear-note` are
omitted. This includes a note the credential cannot read: the CLI sends a
non-empty PATCH without a note field and never reads, merges or rewrites a
hidden note. `--clear-note`, or an explicit empty `--note=`, clears the note.
A non-empty `--note` replaces it. A note is at most 500 characters.

Note text passed with `--note` is visible in the process argument list and may
be retained by shell history. Do not pass sensitive note text on the command
line. Previews show only keep, set, clear or none, and write JSON never echoes
note text.

## Credentials, origin and precedence

By default, the selected local profile supplies the origin-bound credential.
The HTTP commands (`auth status`, `list`, `get`, `create`, `update` and
`delete`) may instead use exactly the trusted process environment values named
`PTO_API_ORIGIN` and `PTO_API_TOKEN`, supplied together by a managed runtime:

- A complete pair is used for that run only; it is never written to either
  local store and never persisted.
- A partial pair is refused.
- An explicit `--profile` combined with either environment field is refused.
- `auth set` and `auth remove` never read that pair.
- The managed environment is not a vault or a configuration file.

`PTO_CLI_WRITES=1` is a separate local write switch, not a credential and not
an alternative to `PTO_API_TOKEN`. A run that uses the environment pair still
needs that switch, the service write flags, the matching scope and live record
authorization.

There is no implicit `.env`, current-directory, browser-cookie, stored-password,
arbitrary-header or redirect fallback. Only the named environment pair is
considered; no other shell data becomes a credential.

HTTPS is required. Plain HTTP is accepted only for the literal loopback hosts
listed above, and only after explicit `--allow-loopback-http` setup or command
opt-in. A saved profile retains its setup opt-in. On every command, `--origin`
is an expected origin to match against the bound credential origin; it is never
a new destination.

Commands require no browser cookies or stored password and do not repeat an
interactive login after setup. Only a write asks for a local confirmation.
`--origin` and `--allow-loopback-http` are accepted by `auth status`, `list`,
`get`, `create`, `update` and `delete`, not by `auth remove`, help or version.

## Output and exit codes

Human output writes result rows to stdout. Diagnostics, prompts and error
guidance go to stderr. With `--json`, stdout is exactly one newline-terminated
JSON object with no banner or extra line.

Success (shape; `data` depends on the command):

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "list",
  "data": { "items": [], "complete": true, "reason": "complete", "pages": 1 }
}
```

Status data example with placeholder values:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "auth-status",
  "data": {
    "profile": "default",
    "origin": "https://pto.example.com",
    "source": "keyring",
    "ownerId": "11111111-1111-4111-8111-111111111111",
    "scopes": ["pto:read"],
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }
}
```

Write results use `create`, `update` or `delete` as the command. A create
success adds `operationId`, `replayed` and `expiresAt`:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "create",
  "data": {
    "record": {
      "id": "11111111-1111-4111-8111-111111111111",
      "ownerId": "22222222-2222-4222-8222-222222222222",
      "version": 1,
      "startDate": "2026-12-07",
      "endDate": "2026-12-07",
      "dayPart": "morning"
    },
    "operationId": "33333333-3333-4333-8333-333333333333",
    "replayed": false,
    "expiresAt": "2026-12-08T12:00:00.000Z"
  }
}
```

Update data is `{"record":{...}}`; delete data is
`{"id":"<UUID>","version":<number>,"ownerId":"<UUID>"}`. A write record
carries only `id`, `ownerId`, `version`, `startDate`, `endDate` and `dayPart`.
The idempotency key and note text are never exposed.

Failure:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "auth-status",
  "error": {
    "code": "AUTH",
    "message": "<fixed safe message>",
    "status": 401,
    "requestId": null,
    "retryAfterMs": null
  }
}
```

A write failure may add an optional `recovery` object:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "update",
  "error": {
    "code": "CONFLICT",
    "message": "<fixed safe message>",
    "status": 412,
    "requestId": null,
    "retryAfterMs": null
  },
  "recovery": {
    "kind": "stale",
    "id": "11111111-1111-4111-8111-111111111111",
    "expectedVersion": 3,
    "before": {
      "id": "11111111-1111-4111-8111-111111111111",
      "ownerId": "22222222-2222-4222-8222-222222222222",
      "version": 3,
      "startDate": "2026-12-07",
      "endDate": "2026-12-07",
      "dayPart": "morning"
    },
    "current": null
  }
}
```

`recovery.kind` is `create-pending` (`operationId`, `expiresAt`),
`outcome-unknown` (`id`, `expectedVersion`) or `stale` (`id`,
`expectedVersion`, `before`, `current`). `before` and `current` are safe
records or `null` when the CLI could not obtain that side, never an invented
record. Write support extends `schemaVersion` 1 additively: consumers must
ignore unknown keys, and an unknown `recovery` kind must be treated as an
unknown outcome, not as success and not as permission to retry automatically.
Read results keep their existing shapes.

`status`, `requestId` and `retryAfterMs` are `null` when unavailable. The
examples above are pretty-printed for documentation; actual stdout is one
line. `partial` is present only for an incomplete `list` and has the shape
`{"items":[...],"complete":false,"reason":"...","pages":<number>}`. It is never
attached to an unrelated operation. Success data is a fixed allowlist of record
fields, and opaque cursors are not exposed.

Invalid usage never reflects raw argv or environment values. A literal
`--json` selects the machine error envelope. Neither output form prints a raw
token, a token id, a token digest, token-bearing configuration, role dumps,
raw error causes, arbitrary response keys, hidden notes, note text, an
idempotency key or a stack trace. Displayed owner names and detail notes are
untrusted text and are sanitized for terminal control and bidi injection
before display; a known active credential and PTO-shaped secrets are redacted
if they appear in displayed text. Request ids remain available for safe
troubleshooting. A pending or unknown write is still a failure with a nonzero
exit; inspect `recovery` before deciding what happened. No write introduces a
new exit code.

| Exit | Error code   | Meaning                                   |
| ---- | ------------ | ----------------------------------------- |
| 0    | -            | Success                                   |
| 2    | `USAGE`      | Invalid command, flag or value            |
| 3    | `AUTH`       | Missing, invalid, revoked or expired auth |
| 4    | `PERMISSION` | Missing scope or denied access            |
| 5    | `NOT_FOUND`  | No matching PTO record                    |
| 6    | `CONFLICT`   | Conflicting state                         |
| 7    | `QUOTA`      | Request quota exceeded                    |
| 8    | `NETWORK`    | Network, timeout or unsafe response       |
| 9    | `INCOMPLETE` | List traversal did not complete           |
| 10   | `LOCAL`      | Local store or unexpected local failure   |
| 130  | `CANCELLED`  | Cancelled by signal or caller abort       |

Cancellation takes precedence over the other classifications. Any partial
rows make a traversal incomplete except on cancellation. If no rows were read
and a specific API failure stopped the traversal, that error's exit code is
retained. A budget, drift or invalid traversal without a specific usable error
is incomplete.

## Scope and safety notes

- Read commands are available. Writes exist only behind the explicit local
  `PTO_CLI_WRITES=1` switch, the service's default-off flags, the matching
  scopes and live authorization. They are not a production rollout.
- `--yes` is a local acknowledgement, never server-verifiable human consent.
  An agent must obtain user approval for the previewed operation first.
- An ambiguous create is not retried with a new key, and an ambiguous update or
  delete is not reported as failed or cancelled. Follow the recovery object and
  the manual reconciliation rules; there is no automatic fallback.
- Note text passed on the command line can reach process listings and shell
  history. Do not use argv for sensitive notes.
- Local removal is not remote revocation; use the signed-in browser UI for
  server-side revocation or replacement.
- The keyring path fails closed. It never silently downgrades to a plaintext
  file or another store, and no local store failure selects an environment
  credential or a stored password.
- The CLI sends no cookies, no arbitrary headers and no browser session. It
  does not follow redirects.
- A revoked or expired credential is explained by fixed guidance without
  prompting for a credential mid-read.
- The credential bundle is never logged, serialized or printed for display.
- Tests use private owned homes, loopback HTTP fixtures and synthetic secrets.
  Do not point them at a real PTO service, production data or a real token.

## Development checks

From the repository root:

```sh
npm run lint -w cli
npm run typecheck -w cli
npm test -w cli
npm run test:coverage -w cli
npm run format:check -w cli
```

## Out of scope

Bulk deletion, create-on-behalf, owner transfer, automatic conflict repair,
server-enforced approval tokens or consent proofs; bypassing or automatically
expanding API scope checks or a read-only PAT; hosted or local MCP; token
issuance or revocation through personal-token credentials; natural-language
date guessing; public npm publication; hosted services; and any deployment or
production access.

## Related

- [`docs/openapi.yaml`](../docs/openapi.yaml) - REST contract.
- [`docs/agent-access-delivery-plan.md`](../docs/agent-access-delivery-plan.md) -
  approved CLI, credential and read-only/write rollout rules.
- [`docs/technical-spec.md`](../docs/technical-spec.md) - architecture and
  adapter limits.
- [`packages/agent-auth/README.md`](../packages/agent-auth/README.md) - local
  profile and origin-binding behavior.
