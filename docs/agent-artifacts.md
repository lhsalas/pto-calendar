# Private versioned agent artifacts (#265)

Local packaging for the terminal CLI and the local stdio MCP server.
There is no public npm publication, no registry credential, no release tag,
no CI artifact upload, no hosted channel, and no production activation in
this story. The repository stays public with no license change (GitHub
reports no detected license; all four workspace packages stay
`private: true` with `UNLICENSED` metadata). Internal use only; a team
distribution location and its access controls need a separate explicit
decision, and actual host setup and approval belong to #266–#268.

Current pinned artifact version: **0.1.0**. All four workspaces
(`@pto-calendar/cli`, `@pto-calendar/mcp`, `@pto-calendar/agent-auth`,
`@pto-calendar/api-client`) are `0.1.0`. This document describes that
version only. A same-version reinstall or slot test verifies that slot
only; it is not a cross-version certification and says nothing about a
historical or future version.

## Runtime floor

- Node.js `>=24.22.3` (`.nvmrc` pins `24.22.3`; the root and workspace
  manifests declare the floor). The pack and smoke entries refuse an older
  runtime.
- npm `>=10.0.0` from the Node toolchain (validated with npm `11.19.1`).
  Building and verifying a bundle also requires GNU tar.
- Bash and GNU coreutils with `mv --update=none-fail` and `--no-copy`
  (tested with coreutils `9.11`). The installer requires an occupied
  destination to return failure and a free destination to accept a rename,
  not a copy. It probes the actual slot filesystem before staging the bundle.
- Linux only for the persistent credential adapters. The preferred backend
  is the Linux Secret Service provider (system Python 3, PyGObject, the
  libsecret `Secret` typelib, a local D-Bus session and an initialized
  unlocked default collection for setup). The plaintext file store is an
  explicit opt-in only (`--storage file` / `storage: 'file'`); it is not
  equivalent to a keyring, and a missing, locked, ambiguous or unavailable
  keyring never downgrades silently. Windows and macOS have no supported
  persistent adapter and fail closed. The one recorded provider preflight
  (Gnome Keyring 51.1 on Fedora 45, libsecret 0.21.8.2, PyGObject 3.58.1,
  Python 3.15.2, private D-Bus) is one tested combination, not certification
  of other distributions, keychains, or production.

## What the bundle holds

`pack.mjs` creates a **new private directory outside the repository** and
refuses an existing output path; it never overwrites a release. After a
local `npm run build`, run:

```sh
npm ci
npm run build
bundle_parent=$(mktemp -d "${TMPDIR:-/tmp}/pto-agent-pack.XXXXXXXX")
bundle="$bundle_parent/agent-tools-0.1.0"
npm run agent:pack -- --output "$bundle"
```

`npm run agent:pack` invokes the pack entry. `npm run agent:pack:check`
runs the pack contract tests, then the clean-install smoke. The bundle
root holds exactly:

- four versioned npm tarballs, one per workspace, directly at the bundle
  root (current names: `pto-calendar-cli-0.1.0.tgz`,
  `pto-calendar-mcp-0.1.0.tgz`, `pto-calendar-api-client-0.1.0.tgz`,
  `pto-calendar-agent-auth-0.1.0.tgz`). Each packed manifest keeps
  `private: true`; no new license or right is granted;
- a generated consumer `package.json` plus a reviewed lock-derived
  `package-lock.json` using relative file tarball references for the four
  local packages and pinned public entries for everything else. The
  generated consumer manifest is itself `private: true` with `UNLICENSED`;
  nothing in the bundle grants a right or changes distribution;
- a `SHA256SUMS` manifest covering all four tarballs and both consumer
  manifests (`package.json` and `package-lock.json`) — six entries, one per
  payload file.

The consumer lock refers to the tarballs by relative path. Keep the bundle
files together when copying or installing them.

Contents are reviewed before use: both bins (`pto`, `pto-mcp`) are
executable, the agent-auth helper `libexec/secret-service.py` is present,
compiled `dist` output and READMEs are included, and no profile, `.env`,
test fixture, PAT, browser state, workspace symlink, hidden file, or secret
ships in the tarballs. CLI/MCP write behavior is unchanged: writes stay
default-off locally (`PTO_CLI_WRITES=1` / `PTO_MCP_WRITES=1` explicitly set
for the run, plus the separately default-off service flags
`PAT_AUTH_ENABLED` / `PAT_WRITES_ENABLED`, matching scopes, and live
role/ownership/version checks). The MCP server negotiates the pinned
`@modelcontextprotocol/sdk` **1.32.2** classic stdio `initialize` up to
**2025-11-25**; host configuration and per-call approval evidence remain
#266–#268 work.

## Verify the bundle (maintainer)

Run the smoke entry after every local build. CI runs the same command as a
fail-closed step of the existing `Build` job, after `npm run build`:

```sh
npm run agent:pack:check
```

`pack-check.mjs` uses an isolated private temporary `HOME`, installs at a
separate temporary prefix outside the checkout from the exact generated
lock, and then:

1. checks archive checksums and tarball contents (members, executable
   bits) before installing anything;
2. installs with the exact bundle lock only — no monorepo `node_modules`
   fallback, no registry substitution for the four local tarballs;
3. validates both bins and ESM resolution, the Node/npm floor, the two
   reviewed `content-type` placements, and the packaged Linux Secret
   Service helper outside the original checkout;
4. initializes classic stdio and runs CLI/MCP `list`/`get` against a
   synthetic loopback-only fixture (disposable synthetic credentials,
   never production or a real token);
5. exercises side-by-side activation, rollback to the intact prior slot,
   profile preservation, and removal of only the owned slot — by installing
   the same version twice side by side under a disposable synthetic file
   profile, switching explicit launch paths, rolling back to the prior
   intact install, and asserting the prior install and the profile bytes are
   unchanged. That proves same-version slot mechanics only: not a
   cross-version upgrade, and nothing about a live profile, a native
   keychain, or another host.

Test failures are not skipped, existing scan/coverage/build gates are
unchanged, and a local pack is not CI evidence. See
[`docs/testing-strategy.md`](testing-strategy.md) for the real per-workspace
coverage floors that still gate every change.

## Install in a fresh private slot (consumer)

Prerequisites: the bundle directory from an owner you already trust, the
expected `SHA256SUMS` obtained separately from that same owner through a
channel you already trust (an absolute path **outside** the bundle
directory), a Linux host meeting the floor above, and a warmed npm cache
holding the reviewed registry pins. Warming the cache is an
operator-selected prerequisite done with approved registry access (for
example from the reviewed source lock): it uploads no cache or bundle
anywhere and never resolves the private workspace scopes from a registry.
A standalone prefix with an initially empty cache installs cleanly from
only the six verified bundle files plus the pinned public dependencies.
The install below stays offline, and the installed slot runs with no
checkout — once installed, the tools run from the slot alone. No shared
cache or bundle distribution channel is provided by this story. The
checksum verifies the files match the trusted expected manifest; it does
**not** authenticate the owner, and the `SHA256SUMS` copy inside the bundle
is untrusted until it is proven byte-identical to the separately obtained
expected manifest. There is no private distribution service behind these
files.

Verification order matters. `sha256sum --check` trusts the file names it is
given, and it accepts a manifest with a single valid line, so inventory,
strict manifest form, and provenance are established **before** it runs and
before anything is installed:

1. the bundle holds exactly the six named payload files as regular files,
   plus its manifest, and nothing else;
2. the manifest holds exactly six unique lines in strict
   `<64 lowercase hex><two spaces><basename>` form naming exactly those six
   files — no directories, no absolute or parent paths, no duplicates, no
   extra names;
3. the in-bundle manifest is byte-identical to the separately obtained
   trusted manifest (`cmp -s`).

The verification and install steps use explicit failure guards so they
stop even when the caller's shell disables `errexit` in a conditional.

Check all digests and run the packed CLI in the private stage before
publishing. The last command is a same-parent, no-clobber rename: no
checksum, path check or program runs after a successful rename. Replace
the two placeholder paths at the end with your absolute paths. Never
install over a live slot or inside the repository checkout:

```bash
# pto agent install — private, offline, no-clobber, never overwrites.
#
# Copy this whole block into a script or paste it into an interactive shell.
# It defines pto_agent_install() and calls it once. The recipe runs inside a
# subshell, so it never runs `exit` in the calling shell: it returns a
# nonzero status instead and prints every disposable path it owns.
#
# Replace the two placeholder paths below with your absolute paths.
pto_agent_install() (
  set -eu
  set -o pipefail
  umask 077
  if [ "$#" -ne 5 ]; then
    printf 'usage: pto_agent_install <bundle> <trusted-manifest> <npm-cache> <slots-dir> <slot-dir>\n' >&2
    exit 2
  fi
  bundle="$1"; expected="$2"; cache="$3"; slots="$4"; slot="$5"
  owned=""
  fail() {
    printf '%s\n' "$@" >&2
    if [ -n "$owned" ]; then
      printf 'owned disposable path retained (exact path): %s\n' "$owned" >&2
      printf 'remove only that exact path when done; there is no automatic cleanup\n' >&2
    fi
    exit 1
  }
  # 0. Absolute paths, the separately trusted manifest, and its location.
  case "$bundle" in /*) ;; *) fail "bundle path must be absolute";; esac
  case "$expected" in /*) ;; *) fail "expected manifest path must be absolute";; esac
  case "$cache" in /*) ;; *) fail "npm cache path must be absolute";; esac
  case "$slots" in /*) ;; *) fail "slots directory must be absolute";; esac
  test "$slot" = "$slots/0.1.0" || fail "ready path must be the 0.1.0 child of the slots directory"
  test -f "$expected" || fail "expected manifest is not a regular file"
  test ! -L "$expected" || fail "expected manifest must not be a symlink"
  bundle="$(realpath -e -- "$bundle")" || fail "cannot resolve bundle path"
  expected="$(realpath -e -- "$expected")" || fail "cannot resolve expected manifest path"
  case "$expected" in "$bundle"/*) fail "expected manifest must live outside the bundle";; esac
  set -- package.json package-lock.json \
    pto-calendar-cli-0.1.0.tgz pto-calendar-mcp-0.1.0.tgz \
    pto-calendar-api-client-0.1.0.tgz pto-calendar-agent-auth-0.1.0.tgz
  # 1. Exact inventory: the six named payload files plus the manifest, nothing else.
  actual="$(LC_ALL=C ls -A -- "$bundle" | LC_ALL=C sort)" || fail "cannot list the bundle directory"
  want="$(printf '%s\n' SHA256SUMS "$@" | LC_ALL=C sort)"
  test "$actual" = "$want" || fail "bundle inventory mismatch"
  for f in "$@" SHA256SUMS; do
    test -f "$bundle/$f" || fail "bundle entry is not a regular file"
    test ! -L "$bundle/$f" || fail "bundle entry must not be a symlink"
  done
  # 2. Strict manifest form: exactly six unique digest-plus-basename lines, known names only.
  # The manifest path is absolute (enforced above), so it cannot be mistaken for an option.
  LC_ALL=C awk '
    {
      name = $2
      known = name ~ /^(package\.json|package-lock\.json|pto-calendar-(cli|mcp|api-client|agent-auth)-0\.1\.0\.tgz)$/
      if (NF != 2 || $0 != $1 "  " name || $1 !~ /^[0-9a-f]{64}$/ || !known || seen[name]++) failed = 1
    }
    END { exit (failed || NR != 6) }
  ' "$bundle/SHA256SUMS" || fail "SHA256SUMS form or entry check failed"
  # 3. Provenance: the in-bundle copy must equal the separately obtained manifest.
  cmp -s -- "$expected" "$bundle/SHA256SUMS" || fail "SHA256SUMS does not match the separately obtained manifest"
  # 4. Digests in the bundle.
  ( cd -- "$bundle" && sha256sum --strict --check "$expected" ) || fail "bundle digest check failed"
  # 5. Slot parent guards and cache presence, before anything is staged.
  mkdir -p -- "$slots" || fail "cannot create slots directory"
  test ! -L "$slots" || fail "slots directory must not be a symlink"
  test -O "$slots" || fail "slots directory must be owned by the current user"
  writable="$(find "$slots" -maxdepth 0 -perm /022)" || fail "cannot inspect the slots directory permissions"
  test -z "$writable" || fail "slots directory must not be group- or other-writable"
  test -d "$cache/_cacache" || fail "npm cache is not warmed; re-warm it from the known pins, then retry"
  node_bin="$(command -v node)" || fail "cannot find Node.js"
  case "$node_bin" in /*) ;; *) fail "use an absolute Node.js toolchain path";; esac
  bin_dir="$(dirname -- "$node_bin")" || fail "cannot resolve the Node.js toolchain directory"
  tool_path="$bin_dir:/usr/bin:/bin"
  # 6. The ready path must not exist yet: install and retry never overwrite it here.
  test ! -e "$slot" || fail "slot already exists; refusing to replace it"
  test ! -L "$slot" || fail "slot path is a symlink; refusing to replace it"
  # 7. Publication primitive. GNU `mv -n` returns 0 when it skips an existing
  #    destination, which would report a publication that never happened, so
  #    the recipe needs `mv --update=none-fail` to refuse loudly and
  #    `mv --no-copy` so the publication is one
  #    same-filesystem rename instead of a copy. Probe using empty directories
  #    on the actual slot filesystem before staging any bundle files.
  mv_help="$(mv --help 2>/dev/null)" || fail "cannot read the mv help output"
  case "$mv_help" in
    *"none-fail"*) ;;
    *) fail "GNU mv with --update=none-fail is required" ;;
  esac
  case "$mv_help" in
    *--no-copy*) ;;
    *) fail "GNU mv with --no-copy is required" ;;
  esac
  probe="$(mktemp -d -- "$slots/.probe.XXXXXXXX")" || fail "cannot create the publication probe directory"
  owned="$probe"
  printf 'owned disposable probe path: %s\n' "$owned" >&2
  mkdir -- "$probe/src" "$probe/dst" || fail "cannot create the publication probe directories"
  probe_src="$(stat -c '%d:%i' -- "$probe/src")" || fail "cannot inspect the probe source"
  probe_dst="$(stat -c '%d:%i' -- "$probe/dst")" || fail "cannot inspect the probe destination"
  if mv --no-target-directory --update=none-fail --no-copy -- "$probe/src" "$probe/dst" 2>/dev/null; then
    fail "this host's mv reports success when it refuses to overwrite; refusing to publish"
  fi
  test "$(stat -c '%d:%i' -- "$probe/dst")" = "$probe_dst" || fail "the publication probe changed an occupied destination"
  test "$(stat -c '%d:%i' -- "$probe/src")" = "$probe_src" || fail "the publication probe moved a source it had to refuse"
  mv --no-target-directory --update=none-fail --no-copy -- "$probe/src" "$probe/dst2" 2>/dev/null \
    || fail "the publication probe could not move to a free destination"
  test ! -e "$probe/src" || fail "the publication probe left its source in place"
  test "$(stat -c '%d:%i' -- "$probe/dst2")" = "$probe_src" || fail "the publication probe did not rename the source"
  rmdir -- "$probe/dst" "$probe/dst2" "$probe" || fail "cannot remove the empty publication probe directories"
  owned=""
  # 8. Private staging sibling: copy, verify, and install there.
  #    The ready path is published only after every check below has passed.
  owned="$(mktemp -d -- "$slots/.stage.XXXXXXXX")" || fail "cannot create staging directory"
  printf 'owned disposable staging path: %s\n' "$owned" >&2
  cp -- "$bundle/package.json" "$bundle/package-lock.json" "$bundle/SHA256SUMS" \
    "$bundle/pto-calendar-cli-0.1.0.tgz" "$bundle/pto-calendar-mcp-0.1.0.tgz" \
    "$bundle/pto-calendar-api-client-0.1.0.tgz" "$bundle/pto-calendar-agent-auth-0.1.0.tgz" \
    "$owned/" || fail "cannot stage bundle files"
  cmp -s -- "$expected" "$owned/SHA256SUMS" || fail "staged SHA256SUMS differs from the trusted manifest"
  ( cd -- "$owned" && sha256sum --strict --check "$expected" ) || fail "staged digest check failed"
  mkdir -- "$owned/install-home" || fail "cannot create install home"
  touch -- "$owned/install-home/user.npmrc" "$owned/install-home/global.npmrc" || fail "cannot create npm config placeholders"
  if ! ( cd -- "$owned" && env -i HOME="$owned/install-home" PATH="$tool_path" \
    npm_config_cache="$cache" npm_config_registry=https://registry.npmjs.org/ \
    npm_config_userconfig="$owned/install-home/user.npmrc" \
    npm_config_globalconfig="$owned/install-home/global.npmrc" \
    npm ci --offline --omit=dev --ignore-scripts --engine-strict --no-fund ); then
    fail "install failed; the ready path was not created"
  fi
  version="$(env -i HOME="$owned/install-home" PATH="$tool_path" "$owned/node_modules/.bin/pto" --version)" \
    || fail "the staged executable did not run"
  test "$version" = 0.1.0 || fail "the staged executable reported the wrong version"
  # 9. Private same-parent relocation: the tools are proven to run from the
  #    directory that will be published, and the content is re-verified
  #    against the separately trusted manifest, before the ready path exists.
  relocated="$slots/.ready.${owned##*.}"
  test ! -e "$relocated" && test ! -L "$relocated" || fail "the private relocation path already exists"
  mv --no-target-directory --update=none-fail --no-copy -- "$owned" "$relocated" \
    || fail "the private relocation rename failed"
  owned="$relocated"
  printf 'owned disposable relocated path: %s\n' "$owned" >&2
  cmp -s -- "$expected" "$owned/SHA256SUMS" || fail "the relocated SHA256SUMS differs from the trusted manifest"
  ( cd -- "$owned" && sha256sum --strict --check "$expected" ) || fail "the relocated digest check failed"
  version="$(env -i HOME="$owned/install-home" PATH="$tool_path" "$owned/node_modules/.bin/pto" --version)" \
    || fail "the relocated executable did not run"
  test "$version" = 0.1.0 || fail "the relocated executable reported the wrong version"
  identity="$(stat -c '%d:%i' -- "$owned")" || fail "cannot read the relocation identity"
  # 10. Publish: return the result of one no-clobber rename. Nothing reads
  #     a path or prints output on the success path after this rename.
  test ! -e "$slot" || fail "the slot appeared during the install; refusing to replace it"
  test ! -L "$slot" || fail "the slot path is a symlink; refusing to replace it"
  printf 'publishing ready path: %s (expected device:inode %s)\n' "$slot" "$identity" \
    || fail "cannot report the intended publication"
  mv --no-target-directory --update=none-fail --no-copy -- "$owned" "$slot" \
    || fail "publication failed; the installer did not replace the ready path"
)
bundle=/path/to/bundle-0.1.0 # untrusted bundle directory
expected=/absolute/path/to/trusted/SHA256SUMS # separately obtained, outside "$bundle"
cache="${npm_config_cache:-$HOME/.npm}" # absolute path to the warmed cache
slots="$HOME/.local/share/pto-calendar/agent-slots"
slot="$slots/0.1.0"
pto_agent_install "$bundle" "$expected" "$cache" "$slots" "$slot"
```

### Invocation contract

The recipe is a shell function whose body runs in a subshell, so it never
runs `exit` in the shell that called it. Every step also carries an
explicit guard, so the recipe still stops correctly when the caller invokes
it from a conditional, where a shell disables `errexit` for the whole
call.

- **Script (recommended).** Save the block and run it with `bash`. Status
  `0` means this invocation published the ready slot. A normal nonzero
  result means it did not publish the slot. Bash's `errexit` option, when
  set on that script, aborts the script and returns the same status.
- **Interactive shell.** Without `errexit`, paste the block and read `$?`.
  With `errexit` enabled, run the saved script in a conditional, for
  example `bash ./install-pto-agent.sh || install_status=$?`. Don't paste
  the block unguarded into an `errexit` shell.

The saved script does not set variables in the invoking shell. The
follow-up commands use the pinned path under `HOME`; they do not need
the installer's `slot` variable.

The recipe adds no ambient npm or environment configuration: it runs `npm`
under `env -i` with explicit `npm_config_*` variables and empty per-run
npmrc placeholders inside the disposable stage.

### What a failure leaves behind

The recipe names every disposable directory it creates or retains. It
removes only the empty probe directories on the successful probe path.
There is no trap or recursive cleanup of install stages or ready slots.

- An install failure such as `ENOTCACHED` leaves no new ready path. Re-warm
  the cache from the known pins only and retry in the same home with a
  fresh stage. Inspect or remove only the exact disposable path the
  installer identifies.
- A directory or symlink (including a dangling link) already at the ready
  path, or created there by a concurrent winner, is left untouched. On a
  rename refusal the installer names its retained private stage.
- If the shell is interrupted during publication, inspect the ready path
  before retrying, with the read-only identity snippet below. A real,
  owned directory whose `device:inode` matches the identity the installer
  printed is the directory this invocation intended to publish. Do not
  remove or overwrite a different directory or symlink.

### Health check of the published slot

The install result is the recipe's exit status. The checks below are
deliberately separate steps, because the recipe runs no executable after
the publication and therefore never turns a health check into an install
result.

Run them only after the installer has exited `0`, with the same `HOME`
used for installation. Each snippet works on its own in a fresh shell.

Report the installed version. This prints `0.1.0`:

```sh
"$HOME/.local/share/pto-calendar/agent-slots/0.1.0/node_modules/.bin/pto" --version
```

Show the available commands:

```sh
"$HOME/.local/share/pto-calendar/agent-slots/0.1.0/node_modules/.bin/pto" --help
```

Use explicit full paths to the verified slot; never `npx <pkg>@latest` and
never an unversioned tag as the standard setup. Anything else runs the
same way.

If a health check fails after a successful install, inspect the ready
path rather than reinstalling over it. If the installer was interrupted
during publication, inspect the path before deciding whether to retry;
the interruption alone does not tell you whether the rename happened.

### Inspecting the ready path (read-only)

This read-only check prints `device:inode` for the current owned, real
directory at the ready path. It removes nothing.

```sh
(
  ready="$HOME/.local/share/pto-calendar/agent-slots/0.1.0"
  if test -d "$ready" && test ! -L "$ready" && test -O "$ready"; then
    stat -c '%d:%i' -- "$ready"
  else
    printf 'no owned, non-symlink ready directory at %s\n' "$ready" >&2
    false
  fi
)
```

Compare the result with the `expected device:inode` value the installer
printed before the rename. If the identity matches and the path is the
owned slot you intended to remove, remove only that exact path by hand.
Do not remove anything while another install is running, if inspection
fails, or if the path or identity differs.

Set up the local credential profile separately with the approved tooling
(`"$HOME/.local/share/pto-calendar/agent-slots/0.1.0/node_modules/.bin/pto"`
`auth set --origin https://<your-host>` on the real host; keyring by
default, explicit `--storage file` only if intended; loopback HTTP only
with explicit `--allow-loopback-http` for the literal hosts `localhost`,
`127.0.0.1`, `[::1]`). Verify **before** switching live use to the new
slot: run a read (`list --from … --to …`, `get <uuid>`) and, for MCP, a
classic stdio `initialize` plus `pto_list`/`pto_get` against an approved
non-production origin, and confirm the versions, scopes, and credential
source. Keep the prior slot intact until the new slot is verified.

## Upgrade, rollback, and uninstall

- **Side-by-side upgrade:** repeat the install with the next approved
  version's bundle, lock, checksums and tarball names. Use a fresh slot for
  that version. Verify it before updating your explicit launch paths. A
  failed attempt leaves no ready path, so retrying reruns the same recipe
  for a new stage.
- **Rollback:** point live use back at the intact prior slot. The prior
  slot is never modified by the upgrade, so rollback is a pointer change,
  not a reinstall.
- **Uninstall:** after switching away from a slot, confirm it is the exact
  owned directory from this install and not a symlink, with the read-only
  identity snippet above. For example, to retire `0.1.0`, run
  `rm -r -- "$HOME/.local/share/pto-calendar/agent-slots/0.1.0"`.
  Never delete the profile directory (`~/.config/pto-calendar/agent-auth`
  by default), never revoke remotely by deleting local files (local
  removal is not remote revocation — use the signed-in browser UI), and
  never paste tokens, digests, profile contents, or slot paths carrying
  secrets into repository files, client configuration snippets, chat
  transcripts, logs, or READMEs.

## What this does not do

- No new repository license or right: `private: true` and `UNLICENSED`
  stay as-is; the public visibility of this repository is unchanged.
- Public GitHub Releases and CI artifacts are **not** a private channel:
  do not upload tarballs, do not publish, and do not change visibility.
- No private team channel is established here; distribution approval
  remains a separate decision.
- A slot check for `0.1.0` certifies that in-kind slot only — it is not
  cross-version certification, and the smoke's disposable file profile says
  nothing about a live profile, a native keychain, or another host.
- No host approval is granted: OpenCode V2, Claude Code, and VS Code/Copilot
  acceptance are #266–#268, each with its own recorded versions,
  transcripts, and approve/reject evidence.
- No production: no live flags, no real token creation, no client config
  writes, no deployment. Production stays closed.
