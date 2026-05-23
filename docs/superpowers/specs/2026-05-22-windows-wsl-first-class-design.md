# Windows + WSL: First-Class Support

**Status:** Draft
**Date:** 2026-05-22
**Author:** Khang Nguyen (with Claude)

## Summary

Fleet is a cross-platform terminal multiplexer, but Windows + WSL is currently
half-supported. Tab titles render Windows paths uncollapsed, WSL launches in
`/mnt/c/…` instead of the user's WSL `$HOME`, there is no way to pick which WSL
distro a tab uses, cold-start latency is invisible to the user, the live-CWD
poller is a no-op on Windows, and the `fleet` CLI is unreachable from inside any
WSL pane.

This spec introduces a `ShellProfile` abstraction that lets every PTY pane carry
the context Fleet needs to handle paths, drag/drop, CWD tracking, and CLI
installation correctly per filesystem. Together with a `WslService` in the main
process, a small new-tab picker, a cold-start overlay, and a WSL status
indicator, it turns Windows + WSL into a first-class platform combo without
spreading `if (process.platform === 'win32')` branches across the codebase.

## Goals

- WSL panes open in the user's WSL `$HOME` by default, not under `/mnt/c/…`.
- Tab titles and Telescope subtitles render with `~`-collapsed, context-aware
  paths.
- Live CWD tracking works on Windows and inside WSL, not just Linux/macOS.
- Users can pick which WSL distro a new tab opens, with a per-workspace default.
- Cold-start latency and WSL health are visible (overlay, status bar).
- The `fleet` CLI and Claude Code hook are reachable from inside every WSL
  distro the user launches a pane into.
- No regressions for macOS, Linux, or Windows-without-WSL users.

## Non-Goals

- Cross-filesystem unified file browsing (Windows + WSL in one tree). Telescope
  inherits the active pane's context only.
- SSH or devcontainer panes. The `ShellProfile` abstraction is shaped so we can
  add these later, but they are not in scope.
- Dragging files *out of* Fleet to Explorer. Existing UX is one-way.
- A new shell other than the user's existing ones. We do not bundle PowerShell
  or any WSL distro.

## Architecture

### Data model

```ts
// src/shared/shell-profiles.ts
type PathContext = 'win32' | 'posix' | { kind: 'wsl'; distro: string };

type ShellProfile = {
  id: string;             // 'windows.powershell', 'wsl.Ubuntu-22.04', 'posix.zsh'
  kind: 'system' | 'wsl';
  label: string;          // 'PowerShell', 'Ubuntu (WSL)', 'zsh'
  command: string;        // 'powershell.exe', 'wsl.exe', '/bin/zsh'
  args: string[];
  pathContext: PathContext;
  icon?: string;
};
```

Tab and Pane gain `shellProfileId: string`. Existing persisted layouts default
to `legacy.system-default`, which the registry resolves to today's
`getDefaultShell()` behavior — no migration needed for macOS/Linux users.

### Module map

```
src/shared/shell-profiles.ts   ShellProfile, PathContext types
src/shared/path-platform.ts    displayPath, basename, join, isWindowsPath
                               (pure, no I/O, given a PathContext)

src/main/shell-profiles.ts     Registry: enumerate profiles on startup
src/main/wsl-service.ts        listDistros, homeDir, toWslPath, toWinPath,
                               status, warmUp, ensureFleetCli,
                               ensureClaudeHook
src/main/pty-manager.ts        Accepts ShellProfile; composes args
src/main/cwd-poller.ts         Adds Windows (pid-cwd) + WSL (OSC 7 from hook)
                               paths
src/main/notification-detector.ts  Tags OSC 7 cwd-changed events with
                                   PathContext

src/renderer/src/components/ShellPicker.tsx       New
src/renderer/src/components/WslStatusBar.tsx      New (Windows-only mount)
src/renderer/src/components/CwdStartingOverlay.tsx New
src/renderer/src/store/workspace-store.ts         cwdBasename → basename(ctx)
src/renderer/src/lib/shorten-path.ts              Takes PathContext
src/renderer/src/components/TerminalPane.tsx      Drop handler uses profile
src/renderer/src/components/Telescope/modes/
  browse-mode.ts                                  Roots derived from profile
```

### Path translation: `WslService`

```ts
class WslService {
  listDistros(): Promise<WslDistro[]>;
  // {name, version, isDefault, state} parsed from `wsl --list --verbose`
  // Output is UTF-16LE — decode explicitly, don't trust default utf-8

  homeDir(distro): Promise<string>;
  // `wsl -d <distro> --exec sh -c 'echo $HOME'`, cached per distro

  toWslPath(distro, winPath): Promise<string>;
  // `wsl -d <distro> --exec wslpath -u "<winPath>"`, batched + cached

  toWinPath(distro, wslPath): Promise<string>;
  // wslpath -w, same caching

  status(distro): Promise<'running' | 'stopped' | 'error'>;
  // From `wsl --list --running` (10s poll), no per-distro spawn

  warmUp(distro): void;
  // `wsl -d <distro> --exec true`, fire-and-forget at app start

  ensureFleetCli(distro): Promise<void>;
  ensureClaudeHook(distro): Promise<void>;
}
```

All path translation goes through `WslService`. The renderer never builds WSL
paths from string manipulation — it asks the service. Caching keys on
`(distro, path)` so repeated drag-drops of the same file do not re-spawn
`wslpath`.

### Launch semantics

```ts
// pty-manager.ts
const profile = shellProfileRegistry.get(opts.shellProfileId);
const args =
  profile.kind === 'wsl' && opts.startInWslHome
    ? ['-d', profile.distro, '~']                       // land in Linux $HOME
    : profile.kind === 'wsl' && opts.wslCwd
    ? ['-d', profile.distro, '--cd', opts.wslCwd]       // explicit WSL dir
    : profile.args;

pty.spawn(profile.command, args, {
  cwd: opts.windowsCwd,  // node-pty needs a Windows path for wsl.exe
  ...
});
```

The trailing `~` is the documented Microsoft pattern (`wsl ~`) to override the
auto-translated Windows cwd. For workspaces where the user wants the workspace
directory on the WSL side (e.g. a repo cloned into `/home/khang/dev/foo`), we
pass `--cd` with a pre-translated WSL path.

### Live CWD tracking

| Platform | Strategy |
|----------|----------|
| Linux    | `readlink /proc/<pid>/cwd` (unchanged) |
| macOS    | `pid-cwd` package (unchanged) |
| Windows native | `pid-cwd` (drop the `process.platform === 'win32'` guard at `cwd-poller.ts:60`) |
| WSL pane | OSC 7 emitted by an installed shell hook |

The shell hook is installed by `WslService.ensureFleetCli` into the distro's
`~/.fleetrc.sh`, sourced from `~/.bashrc`, `~/.zshrc`, `~/.profile`. It emits
`\x1b]7;file://localhost<cwd>\x1b\\` from `PROMPT_COMMAND` / `precmd` / `chpwd`.
Idempotent.

`notification-detector.ts` tags emitted `cwd-changed` events with the pane's
`PathContext` so the renderer knows a `/home/khang/dev` path is a WSL path even
though it starts with `/`.

### Cold-start UX

- `CwdStartingOverlay` mounts inside `TerminalPane` for WSL profiles. Renders
  centered "⏳ Starting Ubuntu-22.04…" until first PTY data or OSC 133;A fires.
  Minimum hold 200ms to avoid flash.
- If the PTY exits non-zero within 3s, the overlay swaps to the error text from
  stderr plus Retry / Run diagnostics buttons.
- `WslService.warmUp(defaultDistro)` fires on app boot — opt-out via setting
  `fleet.wsl.preWarm`.

### Status indicator

`WslStatusBar` mounts in the status footer **only when `process.platform ===
'win32'`**. Shows a colored dot + active distro + dropdown:

- Green: running. Menu: terminate, set default, info.
- Yellow: stopped. Menu: start.
- Red: WSL service down or distro error. Menu: open diagnostics modal.

The diagnostics modal runs `wsl --status` + `wsl --list --verbose`, checks for
the "Virtual Machine Platform" Windows feature, and renders copy-pasteable
remediation steps.

### Drag / drop

`TerminalPane`'s drop handler:

1. Read the pane's `PathContext`.
2. If WSL and the dropped path is a Windows absolute path
   (`/^[A-Za-z]:[\\/]/`), call `wslService.toWslPath(distro, p)`.
3. Quote with POSIX rules (single-quotes, internal `'` → `'\''`) for WSL
   regardless of host platform.
4. Bracketed-paste insert (unchanged).

`quotePathForShell(filePath, ctx)` gains a second `PathContext` arg and routes
off that, not `process.platform`.

### Telescope `browse-mode`

Browse mode inherits the active pane's `PathContext`:

- WSL pane → backing list from `wsl -d <distro> --exec fd --type f --hidden
  --exclude .git`, falling back to `find`. Roots default to pane's live cwd;
  quick-jump anchors `~` and `/mnt/c`.
- Windows pane → existing host-side fd/find. Roots default to workspace dir;
  quick-jump anchors `%USERPROFILE%` and visible drive roots.

`displayPath(path, ctx, ...)` is used for the subtitle in every mode, fixing the
`/mnt/c/…` tab-subtitle bug in `panes-mode.ts:38`.

### Fleet CLI inside WSL

`WslService.ensureFleetCli(distro)` runs on first pane spawn into `distro`:

1. `wsl -d <distro> -- mkdir -p $HOME/.fleet/bin $HOME/.fleet/lib`
2. Stream `fleet-cli.mjs` (and `chunks/`) into the distro via `wsl -d <distro>
   -- tee` from the host's bundled output.
3. Write the existing bash wrapper (already POSIX-compatible) to
   `$HOME/.fleet/bin/fleet` and `chmod 755`.
4. Append `export PATH="$HOME/.fleet/bin:$PATH"` to `~/.bashrc`, `~/.zshrc`,
   `~/.profile` (idempotent — same pattern as `addFleetBinToShellProfile`).

### Fleet bridge socket

Today the bridge listens on a Unix socket. WSL panes cannot reach Windows-side
Unix sockets reliably. Change: on Windows, the bridge listens on
`127.0.0.1:<random-port>`, writes the port to `$HOME/.fleet/socket-port` (host)
and *also* to `$HOME/.fleet/socket-port` inside each distro on
`ensureFleetCli`. CLI on both sides reads the port file. macOS/Linux keep the
Unix socket — no regression.

### Claude Code hook inside WSL

`WslService.ensureClaudeHook(distro)` installs the hook into the distro's
`$HOME/.claude/settings.json`. Idempotent. Runs on first WSL pane spawn into
that distro, same trigger as `ensureFleetCli`.

## Data Flow

```
User clicks "+" in tab strip
  → ShellPicker opens (Windows) or addTab() directly (other OS)
  → User picks "Ubuntu-22.04 (WSL)"
  → workspace-store.addTab(profileId='wsl.Ubuntu-22.04', cwd=workspaceDir)
  → IPC: pty.create({ shellProfileId, windowsCwd, startInWslHome: true })
  → main: WslService.ensureFleetCli(distro) (fire-and-forget if cached)
        ↘ pty.spawn('wsl.exe', ['-d', 'Ubuntu-22.04', '~'], { cwd: ... })
  → CwdStartingOverlay mounts in TerminalPane
  → First data arrives → overlay fades
  → Shell sources .fleetrc.sh → OSC 7 fires → cwd-poller marks osc7Seen
  → notification-detector emits cwd-changed with ctx=wsl:Ubuntu-22.04
  → workspace-store updates tab.cwd
  → TabItem renders basename(cwd, ctx) → "dev"  (not "/mnt/c/...")
```

## Error Handling

- `wsl.exe --status` fails → registry skips WSL profiles, logs warn.
- A specific distro is in `Stopped` state on listing → still shown in picker,
  with state badge; launching it triggers a cold-start (expected).
- `wslpath` returns non-zero → cache the error briefly (1s) so we don't hammer
  on repeated drops; surface a one-line toast.
- PTY exits ≤3s after spawn → overlay switches to error state.
- `ensureFleetCli` fails → log + toast, don't block pane creation.

## Testing

- Unit tests for `path-platform.ts` (pure functions) covering: Windows path
  detection, WSL path detection, `displayPath` with all three contexts,
  `basename` with backslash and forward-slash inputs.
- Unit tests for `WslService` parsing of `--list --verbose` (UTF-16LE fixture).
- Integration test (Windows CI only — add a `runs-on: windows-latest` job):
  spawn a WSL profile, assert cwd lands in `$HOME`, assert OSC 7 fires.
- Manual QA matrix: Win11 + Ubuntu-22.04, Win11 + Debian + Ubuntu (two distros),
  Win11 no WSL, macOS, Linux.

## Pitfalls (call out for implementers)

- `wsl.exe --list --verbose` output is **UTF-16LE** on Windows. Default Node
  decoding will produce garbled strings. Use `iconv-lite` or decode manually.
- The Windows `cwd` passed to `pty.spawn('wsl.exe', …)` is auto-translated by
  WSL — that is the source of the `/mnt/c/…` bug. Override with `~` or
  `--cd`.
- `node-pty` on Windows uses ConPTY (Win10 1809+). All existing args-as-array
  spawning is fine; do not switch to pre-escaped command strings.
- Unix sockets do not work across the WSL/Windows boundary cleanly. Use
  `localhost:<port>` on Windows.
- `pid-cwd` works on Windows but spawns may be sandboxed in some Electron
  builds. Verify under packaged build before shipping.

## Rollout

Phased plans (each gets its own PLAN.md):

1. **Foundation** — `ShellProfile` types, registry, `WslService`,
   `path-platform`, IPC. No UI changes yet. Existing flow uses
   `legacy.system-default` profile.
2. **Launch fix** — `pty.spawn` consumes profile; WSL lands in `$HOME`; tab
   title uses `displayPath`. Smallest user-visible win.
3. **Live CWD** — drop `win32` guard in `cwd-poller`; install OSC 7 hook in
   WSL via `ensureFleetCli` foundation.
4. **Picker & cold-start UX** — `ShellPicker`, `CwdStartingOverlay`,
   per-workspace default.
5. **CLI & hooks inside WSL** — `ensureFleetCli`, `ensureClaudeHook`, socket
   switch to localhost on Windows.
6. **Status bar & diagnostics** — `WslStatusBar`, diagnostics modal,
   `warmUp` pre-warm.

Phases 1 + 2 + 3 are the minimum for the pain you reported. The rest are
incremental and shippable independently.
