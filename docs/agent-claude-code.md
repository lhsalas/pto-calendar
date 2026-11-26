# Claude Code: read-only PTO access

This is the read-only setup for [#267](https://github.com/lhsalas/pto-calendar/issues/267).
The packed CLI and native Claude Code reads passed against disposable data. No `apply` was
approved. This guide does not cover hosted inference, hosted MCP, other clients, or production.

Official sources (recheck before use): [MCP](https://code.claude.com/docs/en/mcp),
[permissions](https://code.claude.com/docs/en/permissions),
[CLI reference](https://code.claude.com/docs/en/cli-reference),
[LLM gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol#settings-for-unrecognized-model-ids),
[LM Studio setup](https://lmstudio.ai/docs/integrations/claude-code).

Reference host: Claude Code `2.1.332` on Fedora 45 x86_64, local stdio MCP `2025-11-25`,
private offline slot `0.1.0` (Node
`24.22.3`, SDK `1.32.2`) per the
[install guide](https://github.com/lhsalas/pto-calendar/blob/master/docs/agent-artifacts.md). Local
inference: exact tested LM Studio model `qwen/qwen3.8-27b` loaded at 64K context on loopback
`http://127.0.0.1:1234`. Use a disposable fixture account, never workspace `node_modules`.

## Disposable setup (owner-only)

Changing `HOME` alone does not isolate the wallet. Before running the CLI, start a separate,
unlocked, password-protected Linux KWallet Secret Service on the disposable bus socket below.
The terminal CLI and the MCP child must use that same private bus. If you cannot isolate it,
stop; do not use your regular wallet or plaintext storage. The LM Studio endpoint is not the
PTO API origin.

Replace the executable paths and PTO origin with your verified install and disposable fixture.
Run these commands in a single disposable human terminal, not through a model tool:

```sh
umask 077
scratch="$(mktemp -d "${TMPDIR:-/tmp}/pto-claude-code.XXXXXXXX")" &&
  mkdir -p -- "$scratch/home" "$scratch/project" "$scratch/claude-config" "$scratch/runtime"
node_bin='/absolute/path/to/verified/node'
slot='/absolute/path/to/agent-slots/0.1.0'
claude_bin='/absolute/path/to/verified/claude'
profile='fixture-readonly'
origin='https://pto.example.com'
bus_address="unix:path=$scratch/runtime/bus"
fixture_run() {
  if ! test -n "$scratch" || ! test -S "${bus_address#unix:path=}" || ! test -O "${bus_address#unix:path=}"; then
    printf '%s\n' 'The private Secret Service bus is not available.' >&2
    return 1
  fi
  env -i HOME="$scratch/home" CLAUDE_CONFIG_DIR="$scratch/claude-config" XDG_CONFIG_HOME="$scratch/home/.config" \
    XDG_DATA_HOME="$scratch/home/.local/share" XDG_STATE_HOME="$scratch/home/.local/state" XDG_CACHE_HOME="$scratch/home/.cache" \
    XDG_RUNTIME_DIR="$scratch/runtime" DBUS_SESSION_BUS_ADDRESS="$bus_address" PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
    LANG=C.UTF-8 TERM=xterm-256color PTO_CLI_WRITES=0 \
    "$@"
}
```

Enter only a session-issued fixture token at the packed CLI's hidden TTY prompt, never in argv,
MCP configuration, logs, or model context. The named profile binds it to the PTO origin. Start
with `pto:read`; grant `pto:notes:read` only for an explicit note test. Do not use `.env`, ambient
`PTO_API_ORIGIN` / `PTO_API_TOKEN`, or header or redirect overrides.

## Packed CLI check (human terminal first)

```sh
fixture_run "$node_bin" "$slot/node_modules/.bin/pto" auth set --profile "$profile" --origin "$origin" --storage keyring
fixture_run "$node_bin" "$slot/node_modules/.bin/pto" auth status --profile "$profile" --origin "$origin"
fixture_run "$node_bin" "$slot/node_modules/.bin/pto" list --from 2026-12-01 --to 2026-12-31 --mine --profile "$profile" --origin "$origin"
record_id='00000000-0000-4000-8000-000000000000'
fixture_run "$node_bin" "$slot/node_modules/.bin/pto" get "$record_id" --profile "$profile" --origin "$origin"
```

For an owned loopback fixture only, append `--allow-loopback-http` to each call. Omitting `--profile`
risks falling back to a different config, so the explicit quoted form is required.

## Host registration (disposable user scope)

`cd` into the owner-only empty project directory first, then register only the named local stdio
server. `--env` carries the nonsecret `PTO_MCP_WRITES=0` flag only; `--` separates the server command.
Do not overwrite the real home, project, or managed policy, or trust a broad or preexisting config:

```sh
cd -- "$scratch/project" &&
  fixture_run "$claude_bin" mcp add --scope user --env PTO_MCP_WRITES=0 --transport stdio pto \
    -- "$node_bin" "$slot/node_modules/.bin/pto-mcp" --profile "$profile"
```

For the owned loopback fixture only, append `--allow-loopback-http` after `--`, alongside
`--profile "$profile"`. Check `/mcp` **inside** the foreground session: expect only the named
local stdio server and no unexpected connectors. If asked about folder trust, confirm only the
empty fixture directory you created. Folder trust is not tool consent.

Before launching, save this example as `$scratch/claude-config/settings.json`, the isolated
user settings file. The rules use the name `pto` from the registration above:

```json
{
  "permissions": {
    "allow": [],
    "ask": ["mcp__pto__pto_list", "mcp__pto__pto_get"],
    "deny": ["mcp__pto__pto_create", "mcp__pto__pto_update", "mcp__pto__pto_delete", "Bash", "PowerShell"],
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable",
    "disableAutoMode": "disable"
  },
  "enableAllProjectMcpServers": false,
  "modelOverrides": { "claude-sonnet-4-5-20250929": "qwen/qwen3.8-27b" }
}
```

`allow` stays empty with manual/default mode and bypass/auto off. `enableAllProjectMcpServers: false`
disables automatic blanket approval for project servers; it is not a connection decision, and every
read still needed its per-call `ask`. `modelOverrides` maps the compatibility ID to the tested Qwen.

## Tested local-model launch

Run only when loopback LM Studio already serves the loaded 64K Qwen model in its tested no-auth mode.
`lmstudio` is the documented dummy token for that loopback case only; it does not disable any existing
LM Studio auth, and real LM tokens stay outside this recipe:

```sh
fixture_launch() (
  cd -- "$scratch/project" || exit
  fixture_run ANTHROPIC_BASE_URL=http://127.0.0.1:1234 ANTHROPIC_AUTH_TOKEN=lmstudio \
    ANTHROPIC_MODEL=claude-sonnet-4-5-20250929 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4-5-20250929 \
    ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5-20250929 ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-5-20250929 \
    CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536 CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
    ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
    "$@"
)
fixture_launch "$claude_bin" --model claude-sonnet-4-5-20250929 --tools "" --setting-sources user --permission-mode default
```

The family aliases point at the same compatibility ID so auxiliary calls stay local; the run used
`--model claude-sonnet-4-5-20250929`, not Anthropic cloud. `--tools ""` with `--setting-sources user`
and `--permission-mode default` keeps built-ins off with no bypass; do not use `--strict-mcp-config`
(it drops the user scope). A direct unrecognized Qwen ID failed first with HTTP `500` from a
mid-conversation system role; the override mapping kept the same Qwen model and fixed it, with no cloud
fallback. If the host asks you to sign in, stop. The native session tried `server/discover` and
then negotiated classic stdio `initialize` at `2025-11-25`.

## Native read check

Call `mcp__pto__pto_list` with `mine: true` and a date range containing one owned synthetic row,
then `mcp__pto__pto_get` with that row's ID. Check the pending read arguments and choose **1. Yes**
for that call only, or **No** if they differ. Do not choose the persistent approval option.

Both native reads returned the expected row over bearer auth without cookies. A token without `pto:notes:read` plus
`includeNote: true` returned `null`; a scoped token with the flag omitted also returned `null`; scoped
plus opt-in returned the note. Separate revoked/expired token trials returned `AUTH` / HTTP `401` on
the next call over the same connection with no retries. No token appeared in output logs. A synthetic
note stays out of the model unless the user permits note text in context.

## Empirical troubleshooting

- Safe discovery is the `/mcp` panel plus the exact per-call `ask` prompts. A missing or locked
  credential fails locally at the tool call.
- Safe recovery is an exact fresh-slot reinstall/reconnect from the verified bundle, then re-verifying
  the origin match.
- Tell local inference failures apart from PTO `401`s: an inference or gateway error names the
  model/gateway, while a credential error keeps the fixed `AUTH` shape. Keep the new profile bound and
  recheck that writes stay disabled.
- The packed MCP `pto_update` preview with the default `pto:read` credential returned `PERMISSION`: a
  packed-only control result, not a native approval, and no writable usage is described here. Separately,
  a native display-only lab answered `No` on a fresh valid `apply` with zero MCP arrivals and zero REST
  or PTO audits. The prompt nested the proposed day part and showed the record ID and version, but not
  the resolved owner, the current/resulting dates, or the original day part; the expander was untested.

## Write status (not certified)

A preview or a separate transcript is not consent. Before enabling writes, verify that the pending
dialog shows the record, owner, dates, and change for each `create`, `update`, and `delete`, with
one-time approval for each and a separate fresh rejection that dispatches nothing. Until then,
keep Claude Code read-only and leave #267 open.
