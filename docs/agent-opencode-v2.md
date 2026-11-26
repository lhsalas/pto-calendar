# OpenCode V2: read-only PTO access

Read-only slice of [#266](https://github.com/lhsalas/pto-calendar/issues/266).
**#266 stays OPEN**: a fresh `Reject` (zero dispatch, zero audit row) passed
in an isolated lab, but full writable approval certification is **deferred**.
No write recipe, no remote/hosted coverage, no Code Mode coverage. Tested
surface: packed CLI `auth status` + `list`, and native `pto_pto_list` /
`pto_pto_get`. The packed CLI `get` was not exercised in the native trial.

Official sources (V2 only):
[Configuration](https://opencode.ai/docs/config),
[MCP servers](https://opencode.ai/docs/mcp-servers),
[Permissions](https://opencode.ai/docs/permissions),
[CLI](https://opencode.ai/docs/cli). Recheck before use.

Reference host: OpenCode `v2.4.1` standalone TUI on Fedora 45 x86_64, local
stdio MCP `2025-11-25`, packed slot `0.1.0` (Node `24.22.3`, SDK `1.32.2`)
per the [install guide](https://github.com/lhsalas/pto-calendar/blob/master/docs/agent-artifacts.md).
Use a disposable fixture account and test home. Do not substitute workspace
`node_modules` or a registry package for the verified offline install.

## Credential setup (disposable terminal only)

Run the CLI in a separate disposable terminal, never through a model tool.
Replace the paths and HTTPS origin below with the verified slot, runtime,
and trusted fixture origin. Do not mix a managed credential environment
with this named-profile flow or load credentials from `.env`:

```sh
node_bin='/absolute/path/to/verified/node'
slot='/absolute/path/to/agent-slots/0.1.0'
profile='fixture-readonly'
origin='https://pto.example.com'
unset PTO_API_ORIGIN PTO_API_TOKEN
export PTO_CLI_WRITES=0
```

Store the session-issued fixture token (read-only `pto:read` by default;
note text needs the explicit `pto:notes:read` opt-in). Setup is the only
stage that reads a secret, over a hidden TTY; the token never enters argv,
config, logs, or transcripts. `https://pto.example.com` is a reserved
placeholder. Linux Secret Service/KWallet was the isolated test backend;
plaintext fallback and loopback plain HTTP are out of scope here:

```sh
"$node_bin" "$slot/node_modules/.bin/pto" auth set --profile "$profile" --origin "$origin" --storage keyring
```

Verify the same named profile and the same `--origin` expectation on every
stage, and confirm the fixture scope, owner, and origin match with CLI
writes disabled:

```sh
"$node_bin" "$slot/node_modules/.bin/pto" auth status --profile "$profile" --origin "$origin"
"$node_bin" "$slot/node_modules/.bin/pto" list --from 2026-12-01 --to 2026-12-31 --mine --profile "$profile" --origin "$origin"
```

Omitting `--profile` risks falling back to a different config, so the
explicit form above is required even though shorter invocations exist.

## Host configuration (global scope)

Merge into the existing global `~/.config/opencode/opencode.json` (or
`.jsonc`); do not overwrite unrelated settings and never put MCP servers in
a terminal `cli.json`. Start the isolated host from the same test profile
and Secret Service context as the CLI, without inherited `PTO_API_ORIGIN` or
`PTO_API_TOKEN`. Replace the example paths with the same absolute Node and
packed entry paths you verified:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "pto": {
        "type": "local",
        "command": [
          "/absolute/path/to/verified/node",
          "/absolute/path/to/agent-slots/0.1.0/node_modules/.bin/pto-mcp",
          "--profile",
          "fixture-readonly"
        ],
        "protocol": "legacy",
        "codemode": false,
        "environment": { "PTO_MCP_WRITES": "0" }
      }
    }
  }
}
```

`protocol: legacy` keeps the classic `initialize` through `2025-11-25`;
never force a newer negotiation. `codemode: false` keeps the tested direct
tool surface. `PTO_MCP_WRITES` is literally `"0"`; higher-precedence entries
may replace this same named server. After editing, `/reload` when needed
and check `/mcps` for connect/disconnect state. Confirm exact key names
against the linked V2 reference. The test used exact rules for the two
read tools, not blanket approval.

## Native read check

Call `pto_pto_list` for a date range containing a record owned by the
fixture account:

```json
{ "from": "2026-12-01", "to": "2026-12-31", "mine": true }
```

Then call `pto_pto_get` with `id` set to that disposable record's ID. The
packed CLI list and native reads returned the expected owned record using
bearer auth, without cookies or repeated browser login. Detail notes were
withheld unless the credential held `pto:notes:read` **and** the call set
`includeNote: true`. Keep sensitive note text out of the model.

## Empirical troubleshooting

- `opencode --standalone mcp list` reported no servers while the TUI `/mcps`
  with the same config showed the server connected. Cause unverified: check
  the actual launching host and config file location before concluding
  anything, since each command can report a different scope.
- Safe recovery is an exact fresh-slot reinstall/reconnect from the verified
  bundle, then re-verify the HTTPS origin match.
- A missing or locked credential fails locally. In separate expiry and
  revocation tests, the next native call returned `AUTH` / HTTP `401`
  without reconnecting. Replace the credential only through the separate
  terminal; never paste it into the model or share raw transcripts.

## Write status (not certified)

Explicit approval cannot be inferred from a preview. One operator-confirmed
**Allow once** applied one synthetic update, and a separate fresh **Reject**
dispatched nothing; that pair is not full write certification. The
fullscreen dialog still lacks the exact record, owner, dates, and change
context. Host UI limitation referenced only:
[anomalyco/opencode#60350](https://github.com/anomalyco/opencode/issues/60350).
When a fix ships in OpenCode V2, re-test with a disposable fixture: verify
the target, owner, dates, and change in the pending dialog before approving
each create, update, and delete. On a separate fresh proposal, reject and
verify zero dispatch and no change. Until then, keep OpenCode read-only.
