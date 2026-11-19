export const HELP_TEXT: string = `pto - read-only PTO Calendar terminal client

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

Credentials:
  list and get require an authorized read scope. A missing scope is an
  authorization failure; the CLI never mints, broadens or substitutes a
  token. By default the selected local profile supplies the credential. The
  three HTTP commands (auth status, list and get) may instead use a complete
  pair of trusted PTO_API_ORIGIN and PTO_API_TOKEN values injected by a
  managed runtime for that run. A partial pair, or an explicit --profile
  combined with either variable, is refused. auth set and auth remove never
  use that pair, and the pair is never written to a store. There is no
  ambient configuration file, cookie, stored-password, arbitrary-header or
  redirect fallback, and the managed environment is never used as a vault.
  Reads use no browser cookie, stored password or repeated interactive login.

  HTTPS is required. Plain HTTP is accepted only for the literal hosts
  localhost, 127.0.0.1 or [::1], and only when loopback HTTP was explicitly
  permitted during setup or on this read with --allow-loopback-http. A saved
  profile keeps its setup opt-in. The --origin option on a read command is an
  expected origin to match against the bound credential origin, not a new
  destination.

Input rules:
  Dates are real calendar dates in YYYY-MM-DD form. The from date must not be
  after the to date, and the inclusive range may span at most 366 days.
  Natural-language dates are not accepted. Owner ids must be canonical UUIDs.
  Use one --flag value or --flag=value spelling for a string option. Boolean
  flags take no value. Repeated flags, unknown flags, the -- separator and
  short flags other than -h are rejected before any store, prompt or network
  access. Invalid commands, profile names, origins, dates, UUIDs and
  pagination values are rejected the same way.

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
  partial rows with complete:false, the reason and the page count. Human
  output writes result rows to stdout and diagnostics to stderr. Neither
  form prints a token, a token id, a token digest, token-bearing
  configuration, role dumps, raw argv, raw environment values, raw error
  causes, arbitrary response keys, hidden notes or a stack trace. Success data
  is a fixed allowlist of record fields; displayed owner names and detail
  notes are untrusted and are sanitized before display. API request ids
  remain available for safe troubleshooting.

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
  traversal without a specific usable error is incomplete.

Help and version accept no setup or read flags and perform no such work: they
open no profile store, read no environment credential, consume no stdin and
send no HTTP request. This build is read-only. It exposes no create, update or
delete command.
`;
