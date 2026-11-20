export const HELP_TEXT: string = `pto - PTO Calendar terminal client

Usage:
  pto [--json]
  pto help [--json]
  pto --help [--json]
  pto -h [--json]
  pto version [--json]
  pto --version [--json]
  pto auth set --origin <https-origin> [--profile <name>]
      [--storage keyring|file] [--allow-loopback-http] [--token-stdin]
  pto auth status [--profile <name>] [--origin <expected-origin>]
      [--allow-loopback-http]
  pto auth remove [--profile <name>]
  pto list --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--mine | --owner <UUID>]
      [--page-size <1..200>] [--max-pages <1..30>]
      [--profile <name>] [--origin <expected-origin>]
      [--allow-loopback-http]
  pto get <UUID> [--profile <name>] [--origin <expected-origin>]
      [--allow-loopback-http]
  pto create --from <YYYY-MM-DD> --to <YYYY-MM-DD>
      --day-part <morning|evening|all_day> [--note <text>]
      [--operation <UUID>] [--yes] [--profile <name>]
      [--origin <expected-origin>] [--allow-loopback-http]
  pto update <UUID> --version <1..2147483647>
      [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]
      [--day-part <morning|evening|all_day>]
      [--note <text> | --clear-note] [--yes] [--profile <name>]
      [--origin <expected-origin>] [--allow-loopback-http]
  pto delete <UUID> --version <1..2147483647> [--yes]
      [--profile <name>] [--origin <expected-origin>]
      [--allow-loopback-http]

Global option:
  --json
      Write exactly one newline-terminated JSON object to stdout. The option
      may appear once, before or after the command and before or after its
      flags. Without it, output is human readable. Diagnostics always go to
      stderr.

Commands:
  auth set
      Store one credential for one trusted origin in a local profile.
      All non-secret arguments are validated before the token is read. The
      token is accepted only from hidden interactive input, or from stdin
      when --token-stdin is given; stdin input ends at a newline followed by
      EOF. A token is never accepted in argv or an option value. The profile
      defaults to default and storage defaults to keyring. --storage file is
      an explicit plaintext, owner-only opt-in and is never selected
      automatically.

  auth status
       Resolve the selected credential once, use GET /auth/me to verify it,
       and report only the profile, origin, source, owner UUID,
      scopes and expiry. If the service rejects the credential because it is
      invalid, revoked or expired, fixed guidance explains how to replace or
      revoke it in the signed-in browser UI. No browser is opened and no token
      is requested during the read.

  auth remove
      Remove the local profile credential only. This is not a remote
      revocation: revoke or replace the token in the signed-in browser UI if
      the server should stop accepting it. The profile defaults to default.

  list
      List PTO records for an explicit inclusive date range. --mine derives
      the owner id from /auth/me; --owner accepts a canonical UUID. The two
      filters are optional and mutually exclusive. Without either filter,
      all records visible to the credential are requested.
      Defaults: page size 100 (range 1..200), at most 30 pages (range 1..30),
      5000 records and 30 seconds total for the whole traversal, including
      the --mine identity read. An early stop never becomes a complete
      absence or a snapshot: any partial rows are reported with their reason
      and page count, and the exit rules below decide the classification.

  get
      Show one PTO record by canonical UUID within a 15-second budget. A
      note is rendered only when the server actually returned it for this
      credential. A missing note is never fabricated.

  create
      Create one PTO owned by the live token holder. There is no owner,
      user, path or URL option: GET /auth/me supplies the actor and owner
      UUID. --from, --to and --day-part are required; the day part is
      morning, evening or all_day, and a multi-day range is stored as
      all_day. Dates are exact ISO dates, ordered, with weekday endpoints;
      an endpoint is never moved. The optional note is at most 500
      characters. The result exposes a safe operation UUIDv4. --operation
      resumes only the same pending approved intent; see Writes.

  update
      Partially update one exact record by canonical UUID. At least one of
      --from, --to, --day-part, --note or --clear-note is required, and
      --note and --clear-note are mutually exclusive. --version is the
      required expected positive int32. The exact detail is read first, a
      mismatched version is refused before dispatch, and the service
      receives a PATCH of only the named fields. The owner cannot change.
      Omitting note options preserves the stored note, including a hidden
      one; --clear-note or --note= clears it. Note text in argv can reach
      process listings and shell history, so do not use it for sensitive
      text.

  delete
      Delete one exact record by canonical UUID after reading its detail.
      --version is the required expected positive int32. There is no
      wildcard, fuzzy match or bulk delete; a mismatched version is refused
      before dispatch and never removes a newer revision.

Writes:
  Writes are disabled by default at two independent layers. The trusted
  host environment must explicitly set PTO_CLI_WRITES=1 for the run; no
  .env file, profile, configuration default or --yes enables it. The
  service independently enforces PAT_AUTH_ENABLED and PAT_WRITES_ENABLED,
  which default to false in every environment and stay disabled for
  production, plus the matching scope, live role and record
  authorization. create needs pto:create and always uses the token owner.
  update needs pto:update:self for an owned record, or pto:update:team
  plus a live team lead or administrator. delete needs pto:delete:self or
  pto:delete:team under the same rule. A self-only lead token cannot
  mutate a teammate. Note reading is separate: pto:notes:read plus
  canViewNote, and a write scope never grants it. The default token stays
  read-only, and no local switch or --yes overrides the service. Each command
  uses only its scoped versioned REST route; there is no legacy unversioned
  mutation fallback.

  With stdin and stderr both terminals, every write prints a safe preview
  on stderr and requires the exact word yes, even when --yes is present.
  Any other answer, EOF or a signal performs no write. When stdin is not a
  terminal, the CLI does not prompt: it refuses without --yes and proceeds
  with it. When stdin is a terminal but stderr is not, the write is refused
  before any credential is read and before any request is sent, even with
  --yes, because the preview could not be shown. --yes is a local
  acknowledgement only; it is not server-verifiable human consent and no
  server approval token exists. An agent must show the proposed operation
  to its user and obtain approval before passing --yes.

  A preview names the safe origin, live actor UUID, exact target owner
  and record UUID (create has none yet), exact ISO dates and day part,
  the current record version for update and delete, and the named changed
  fields. Note handling is keep, set, clear or none; private note text is
  not shown.

  update and delete read exact target detail first and reject a stale or
  malformed version before dispatch. A 412 stale conflict refetches once,
  reports the approved baseline next to the current safe fields or a
  non-invented unavailable result, and requires fresh reconfirmation with
  the new version; it never overwrites or retries automatically.

  create keeps one durable pending operation for one approved intent. A
  safe operation UUIDv4 is returned; it is a public identifier separate
  from the private idempotency key. An ambiguous create is reported as
  create-pending with the operation id and expiry, never as failed and
  never retried with a new key. A second plain create while pending does
  not dispatch. Resume before expiry only by repeating the same approved
  fields with --operation <UUID>; the CLI verifies the same origin, live
  actor, credential public id and normalized payload and applies the same
  confirmation rule, with at most one write. After expiry or token
  replacement, reconcile manually: inspect live records and audit with a
  separate read, ensure no other invocation is running, then privately
  archive the preserved pending state. There is no automatic unlock, key
  rotation, state deletion or fresh-key fallback. The guard covers this
  host only; the service overlap rule and idempotency window remain the
  final guards. The private state location is an implementation detail of
  the build; do not invent or hand-edit it.

  An update or delete whose request was dispatched but whose answer was
  lost is reported as outcome-unknown with its id and expected version,
  never as failed or cancelled. Re-read before another attempt; no write
  is retried automatically. An overlap or other 409 is a conflict with no
  automatic repair.

Credentials:
  list and get require an authorized read scope. create, update and delete
  require their matching write scopes, the service write gates and live
  record authorization. A missing scope or a disabled gate is an
  authorization failure; the CLI never mints, broadens or substitutes a
  token. By default the selected local profile supplies the credential. The
  HTTP commands (auth status, list, get, create, update and delete) may
  instead use a complete pair of trusted PTO_API_ORIGIN and PTO_API_TOKEN
  values injected by a managed runtime for that run. A partial pair, or an
  explicit --profile combined with either variable, is refused. auth set and
  auth remove never use that pair, and the pair is never written to a store.
  There is no ambient configuration file, cookie, stored-password,
  arbitrary-header or redirect fallback, and the managed environment is never
  used as a vault. Commands use no browser cookie, stored password or
  repeated interactive login. PTO_CLI_WRITES is a separate local switch, not
  a credential and not an alternative to PTO_API_TOKEN.

  HTTPS is required. Plain HTTP is accepted only for the literal hosts
  localhost, 127.0.0.1 or [::1], and only when loopback HTTP was explicitly
  permitted during setup or on this command with --allow-loopback-http. A
  saved profile keeps its setup opt-in. The --origin option is an expected
  origin to match against the bound credential origin, not a new destination.

Input rules:
  Dates are real calendar dates in YYYY-MM-DD form. The from date must not be
  after the to date, and an inclusive read range may span at most 366 days.
  Natural-language dates are not accepted. Owner ids must be canonical UUIDs.
  For writes, dates are ordered and must not start or end on a Saturday or
  Sunday; a multi-day range is stored as all_day. A created range may span at
  most 366 days. --version is a positive int32 in 1..2147483647. An update
  needs at least one change option, and a note is at most 500 characters. Use
  one --flag value or --flag=value spelling for a string option. Boolean
  flags take no value. Repeated flags, unknown flags, the -- separator and
  short flags other than -h are rejected before any store, prompt or network
  access. Invalid commands, profile names, origins, dates, UUIDs, versions
  and write values are rejected the same way.

Output:
  With --json, stdout is exactly one newline-terminated JSON object:
    success: {"schemaVersion":1,"ok":true,"command":"<command>","data":{...}}
    failure: {"schemaVersion":1,"ok":false,"command":"<command>"|null,
              "error":{"code":"<code>","message":"<safe text>",
                       "status":<http-status>|null,
                       "requestId":"<request-id>"|null,
                       "retryAfterMs":<milliseconds>|null},
              "partial":{...}}
  partial is present only when a list traversal stopped early; it carries the
  partial rows with complete:false, the reason and the page count. A write
  failure may add an optional recovery object, and a write success carries
  write data:
    create: {"record":{...},"operationId":"<uuid>","replayed":<bool>,
             "expiresAt":"<iso>"}
    update: {"record":{...}}
    delete: {"id":"<uuid>","version":<number>,"ownerId":"<uuid>"}
  A write record carries only id, ownerId, version, startDate, endDate and
  dayPart; note text and the idempotency key are never echoed. recovery has
  kind create-pending (operationId, expiresAt), outcome-unknown (id,
  expectedVersion) or stale (id, expectedVersion, before, current), where
  before and current are safe records or null. Write support extends
  schemaVersion 1 additively: consumers must ignore unknown keys and must
  treat an unknown kind as an unknown outcome, never as success and never as
  permission to retry automatically. Human output writes result rows to
  stdout and diagnostics to stderr. Neither form prints a token, a token id,
  a token digest, token-bearing configuration, role dumps, raw argv, raw
  environment values, raw error causes, arbitrary response keys, hidden
  notes, note text, an idempotency key or a stack trace. Success data is a
  fixed allowlist of record fields; displayed owner names and detail notes
  are untrusted and are sanitized before display. API request ids remain
  available for safe troubleshooting.

Exit codes:
  0    success
  2    usage
  3    authentication
  4    permission
  5    not found
  6    conflict
  7    quota
  8    network, timeout or unsafe response
  9    incomplete result
  10   local or unexpected failure
  130  cancelled

  Cancellation takes precedence over the other classifications. Any partial
  list rows make the outcome incomplete except on cancellation. When no rows
  were read and a specific API failure stopped the traversal, that error's
  exit classification is retained instead. A budget, drift or invalid
  traversal without a specific usable error is incomplete. A pending or
  unknown write is a failure with a nonzero exit; inspect recovery before
  deciding what happened. No write adds an exit code.

Help and version accept no setup, read or write flags and perform no such work:
they open no profile store, read no environment credential, consume no stdin
and send no HTTP request. This build implements gated writes: the explicit
local PTO_CLI_WRITES=1 switch and the service's default-off write gates and
scopes must both allow the operation. Nothing here is a production rollout.
`;
