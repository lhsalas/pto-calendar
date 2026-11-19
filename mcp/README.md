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

## Cancellation

A cancelled call — a client cancellation, a closed stdin, or a stopped
server — reaches the local credential lookup as well as the API request. The
lookup stops the operating system credential helper through the same
termination path as its timeout: the helper process, the profile lock and
the tool slot of the call are released as soon as the call is cancelled, not
after the helper timeout. No API request is started for a cancelled call, and
the cancelled request is answered with nothing. The reason of a cancellation
is never read, so client text can never travel into an error.

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
after artifacts exist.
