# `@pto-calendar/cli`

Read-only terminal client for the PTO Calendar API. This is a private workspace
for the Stage 5 read-only pilot. Nothing in this story publishes an npm
artifact, provides a global install, ships a container image or starts a hosted
service. Build and run it from this checkout, and use only disposable test data
and reserved placeholder origins.

The CLI exposes help, version, credential setup/status/removal, `list` and
`get`. It has no create, update or delete command. A missing scope is reported
as an authorization failure; the CLI never mints or broadens a token.

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
below use `pto` for brevity. Do not install, publish or redistribute this
workspace as an npm package.

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

Add `--json` once, before or after the command and before or after its flags,
to request the stable machine format. Without it, output is human readable.
Result data goes to stdout; diagnostics and prompts go to stderr.

Use one `--flag value` or `--flag=value` spelling per string option. Boolean
flags take no value. Repeated flags, unknown flags, the `--` separator and
short flags other than `-h` are rejected before any store, prompt or network
access. Invalid commands, profile names, origins, dates, UUIDs and pagination
values are rejected the same way.

Help and version are offline: they read no profile store, environment
credential, stdin or network, and they accept no setup or read flags. Only
explicit `auth set` asks for a credential; reads never prompt.

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

## Credentials, origin and precedence

By default, the selected local profile supplies the origin-bound credential.
The three HTTP commands (`auth status`, `list`, `get`) may instead use exactly
the trusted process environment values named `PTO_API_ORIGIN` and
`PTO_API_TOKEN`, supplied together by a managed runtime:

- A complete pair is used for that run only; it is never written to either
  local store and never persisted.
- A partial pair is refused.
- An explicit `--profile` combined with either environment field is refused.
- `auth set` and `auth remove` never read that pair.
- The managed environment is not a vault or a configuration file.

There is no implicit `.env`, current-directory, browser-cookie, stored-password,
arbitrary-header or redirect fallback. Only the named environment pair is
considered; no other shell data becomes a credential.

HTTPS is required. Plain HTTP is accepted only for the literal loopback hosts
listed above, and only after explicit `--allow-loopback-http` setup or read
opt-in. A saved profile retains its setup opt-in. On read commands, `--origin`
is an expected origin to match against the bound credential origin; it is never
a new destination.

Reads require no browser cookies or stored password and do not repeat an
interactive login after setup. `--origin` and `--allow-loopback-http` are
accepted by `auth status`, `list` and `get`, not by `auth remove`, help or
version.

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

`status`, `requestId` and `retryAfterMs` are `null` when unavailable. The
examples above are pretty-printed for documentation; actual stdout is one
line. `partial` is present only for an incomplete `list` and has the shape
`{"items":[...],"complete":false,"reason":"...","pages":<number>}`. It is never
attached to an unrelated operation. Success data is a fixed allowlist of record
fields, and opaque cursors are not exposed.

Invalid usage never reflects raw argv or environment values. A literal
`--json` selects the machine error envelope. Neither output form prints a raw
token, a token id, a token digest, token-bearing configuration, role dumps,
raw error causes, arbitrary response keys, hidden notes or a stack trace.
Displayed owner names and detail notes are untrusted text and are sanitized for
terminal control and bidi injection before display; a known active credential
and PTO-shaped secrets are redacted if they appear in displayed text. Request
ids remain available for safe troubleshooting.

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

- This is a read-only pilot. Create, update and delete are deliberately absent.
- Local removal is not remote revocation; use the signed-in browser UI for
  server-side revocation or replacement.
- The keyring path fails closed. It never silently downgrades to a plaintext
  file or another store, and no local store failure selects an environment
  credential or a stored password.
- The CLI sends no cookies, no arbitrary headers and no browser session. It
  does not follow redirects.
- A revoked or expired credential is explained by fixed guidance without
  prompting mid-read.
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

Creating, updating or deleting PTO; hosted or local MCP; token issuance or
revocation through personal-token credentials; natural-language date guessing;
public npm publication; and any deployment or production access.

## Related

- [`docs/openapi.yaml`](../docs/openapi.yaml) - REST contract.
- [`docs/agent-access-delivery-plan.md`](../docs/agent-access-delivery-plan.md) -
  approved CLI, credential and read-only rollout rules.
- [`docs/technical-spec.md`](../docs/technical-spec.md) - architecture and
  adapter limits.
- [`packages/agent-auth/README.md`](../packages/agent-auth/README.md) - local
  profile and origin-binding behavior.
