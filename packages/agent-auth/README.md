# `@pto-calendar/agent-auth`

Private Node ESM workspace for origin-bound PTO credentials shared by future
CLI and local stdio MCP adapters. It is unpublished and adds no command,
network request or server feature. The Node minimum is **24.22.3**.

This is a library for trusted host code. It ships no CLI command, MCP server,
adapter activation or remote token operation.

## Library surface

`createAgentAuth(options?)` is the stable trusted-host entry point. Its only
factory option is an optional trusted absolute directory for the local store;
the default is `~/.config/pto-calendar/agent-auth`, and the current working
directory is never consulted. The facade has four operations:

- `setProfile({ profile, baseUrl, token, storage?, allowLoopbackHttp? })`
  validates the non-secret lowercase profile name, normalizes and binds one
  origin, and stores the selected policy. `storage` defaults to the OS keyring;
  only an explicit `'file'` writes a plaintext token into the owner-only
  directory. An existing profile keeps its origin and storage: changing either
  requires local removal and new setup, not an override.
- `resolve({ profile?, baseUrl?, env?, allowLoopbackHttp?, signal? } = {})`
  returns one frozen bundle with `baseUrl`, `credential: { origin, token }`,
  `allowLoopbackHttp`, `profile` and `source`. The optional `baseUrl` must
  normalize to the bound origin, so a credential is never returned for a
  different server. Pass the bundle directly to the API client; do not log
  or serialize it for display. The optional `signal` belongs to the trusted
  host, never to a tool argument: it cancels the lookup, and its absence
  preserves the behavior of every existing caller.
- `status({ profile?, baseUrl?, env?, allowLoopbackHttp? } = {})` reports only
  the local `{ profile, origin, source, ready, guidance }` state. It never
  returns a token, a path or a raw error object.
- `removeProfile(profile)` removes the local record and returns a secret-free
  result. For keyring storage the credential-store entry is removed before the
  profile metadata, so an unavailable or uncertain store leaves the metadata in
  place; this is still only a local removal, never a remote revocation.

The facade is called from trusted host configuration, never with model- or
tool-supplied arguments. An adapter resolves a profile before it builds a
request and never opens setup from a tool call.

The package also exports `AgentAuthError` with a fixed machine code and no raw
cause, `AGENT_AUTH_GUIDANCE` with fixed guidance strings that carry no token,
origin, path, host or raw error data, and `readSecretInput` for setup only.
`resolve` and `status` may read a stored credential, but none of `resolve`,
`status` or `removeProfile` consumes interactive secret input, calls
`readSecretInput` or prompts.

## Explicit setup input

`readSecretInput({ mode: 'stdin' | 'tty', input?, signal? })` is the only
interactive secret-input path, and it belongs to setup rather than to a tool
call. It returns the token to its caller and never writes, logs or echoes it,
and it never places it in an argument or an environment variable.

- `stdin` reads exactly one line terminated by a newline; an optional trailing
  carriage return is accepted for CRLF. The pipe must then reach EOF. A missing
  terminator, any byte after the terminator, input over 256 bytes or a line
  that is not a valid token fails closed. A terminal is refused in `stdin`
  mode.
- `tty` is accepted only for a real TTY with hidden raw-mode support. It echoes
  nothing, handles Backspace and Ctrl-C cancellation, refuses control and
  escape bytes, and restores the terminal's raw mode and flow on every exit.

## Profile resolution

- Local profiles default to `~/.config/pto-calendar/agent-auth`. The host
  selects a non-secret lowercase name, with `default` used when omitted.
  A configured profile fixes its origin and selected storage backend. Changing
  either requires local removal and new setup, not an override.
- The host can explicitly inject `PTO_API_ORIGIN` and `PTO_API_TOKEN` together
  using the `env` option. They are not discovered from the environment or
  `.env` files, are never persisted, and cannot be combined with a named
  profile. A base URL override is valid only if it matches the credential's
  normalized origin. For development HTTP, opt into a supported literal
  loopback host explicitly.
- Setup defaults to the supported OS keyring. Opt into `storage: 'file'`
  explicitly to store a plaintext token in the validated owner-only Linux
  profile directory. This is **not** equivalent to a keyring: owner processes
  and backups may read it. A missing, locked, ambiguous or unavailable keyring
  never triggers a plaintext downgrade and never selects another local source.
- Resolve or load the profile before sending API requests. Status reports only
  non-secret local configuration, not remote token validity.
- A resolution may carry one optional trusted `AbortSignal`. The signal is
  read at the start of the resolution, again after the profile record was
  read, and again after the credential was read: a cancelled resolution
  never opens the credential store, never uses a credential that arrived
  late, and never holds the profile lock longer than the call. The lookup
  stops the credential helper through the same termination path as its
  timeout, so the helper process, the profile lock and the caller's slot are
  released as soon as the call is cancelled. The failure is the existing
  fixed `INPUT_CANCELLED` code: the reason of the signal is never read, so it
  can never carry a cause, a secret or client text into an error. Only an
  actual signal is admitted; anything else is refused with the fixed
  `INVALID_OPTIONS` code before a single store is touched. `setProfile`,
  `status` and `removeProfile` are unchanged and never take a signal.

## Local presence and remote state

`status()` describes this machine only. `ready: true` means a local record is
present and structurally usable; it does not mean the server still accepts the
token. Expiry and revocation are server-side, so the library never performs a
remote validity check and never turns local presence into a validity claim.

A missing, locked, ambiguous or unavailable store never yields a credential:
the operation fails closed, or `status()` reports `ready: false` with fixed
guidance. It never falls back to a plaintext file, another credential store or
an ambient environment value. A caller-supplied environment pair is an explicit
runtime-only mode, not a hidden fallback.

When the service rejects a credential as unauthenticated, the adapter can show
the fixed `AGENT_AUTH_GUIDANCE.unauthenticated` text. It asks the user to
verify the intended origin and replace or revoke the token in the signed-in
browser UI, and it never opens an authentication prompt during tool execution.
Removing a profile deletes only the local record; it does not revoke the token
remotely. Revocation or replacement is a separate action in the authenticated
browser UI.

## Execution host support

Only Linux is implemented for the persistent adapters. The Linux OS store uses
a Secret Service provider, system Python 3, PyGObject and the libsecret
`Secret` typelib. It needs the local user's D-Bus session and an initialized
unlocked default collection for setup. Resolving a token never attempts to
unlock or prompt. A Linux remote or container host without that session cannot
use an unrelated desktop's credential store. The owner-only file option is
implemented for Linux permissions only. Windows and macOS have no supported
persistent adapter here; they fail closed with a typed error rather than
promising an untested keychain combination.

This package is not released. The recorded evidence for this workspace is 399
package tests plus a separately compiled disposable Gnome Keyring 51.1
preflight on Fedora 45, using local Secret Service, libsecret 0.21.8.2,
PyGObject 3.58.1, Python 3.15.2 and a private D-Bus. It exercised exact-scope
create/read/update/remove and locked refusal without HTTP, the desktop keychain
or real credentials. That is one tested provider combination: it does not
extend support to macOS or Windows, every Linux distribution or keychain, or
production. The preflight is separate from full CI and does not stand in for
the full CI result. Managed runtime injection is separate from either
persistent backend.

## Operator limits

The file adapter requires actual Linux procfs and a trusted absolute directory
whose ancestors are real directories, not symbolic links. A different directory
does not isolate Secret Service entries on the same bus: use a different profile
name or an isolated session if separation is needed. A stale lock fails closed:
verify that no other process holds it before inspecting it, and remove only a
lock confirmed stale. A corrupt binding is refused for operator repair, not
rewritten. An unknown local set or remove outcome needs local inspection and
reconciliation; it never permits a fallback store or a claim that the operation
succeeded.

The package does not include a CLI or MCP setup flow. Do not place a token in
shell arguments, editor settings or model context. When the server rejects a
token, verify the intended origin and replace or revoke it in the signed-in
browser. **Local profile removal does not revoke the remote token.**

## Local development

Root lint, typecheck, unit test, coverage and build scripts include
`packages/agent-auth`. The focused suite uses private temporary directories,
fake store and terminal ports, and synthetic credentials. It does not access a
developer's keychain or a real server. The workspace contributes one
instrumented CI unit run, not separate test and coverage invocations; the
recorded provider preflight above is separate from full CI. See
[issue #260](https://github.com/lhsalas/pto-calendar/issues/260).
