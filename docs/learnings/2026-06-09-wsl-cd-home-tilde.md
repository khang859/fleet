# Learnings: WSL tabs failed with "zsh: permission denied" (2026-06-09)

## Problem

After the WSL distro-detection fix shipped (v2.60.0), opening a plain WSL
terminal tab on Windows immediately printed:

```
zsh: permission denied: /home/<user>
```

## Root cause

Two things combined:

1. The pre-existing WSL spawn args were `['-d', <distro>, '~']`, i.e.
   `wsl.exe -d Ubuntu ~`. The bare-`~` "start in home" shorthand **only works
   for the bare `wsl ~` invocation**. Once `-d <distro>` is present, wsl.exe
   treats the trailing `~` as the **command to run**. The distro's login shell
   (zsh) then tries to *execute* `~` → the home directory → "permission denied"
   (you can't exec a directory).

2. This never surfaced before because WSL distro detection was broken (UTF-16LE
   without a BOM was mis-decoded and dropped every distro). With no WSL profiles
   detected, WSL was never auto-selected as the default shell, so the buggy
   `wsl -d <distro> ~` path was never exercised. Fixing detection in v2.60.0
   made WSL the default for WSL users — exposing the latent bug.

## Fix

Use the documented `--cd` flag instead of a positional `~`:

```ts
// pty-manager.ts
baseArgs = ['-d', distro, '--cd', '~'];   // was: ['-d', distro, '~']
```

`wsl --cd ~` sets the starting directory to the Linux home path without being
interpreted as a command.

## Takeaway

- `wsl ~` (bare) and `wsl -d <distro> ~` are NOT equivalent — the latter runs
  `~` as a command. Always use `--cd <dir>` to set the start directory when a
  distro is specified.
- A "robustness" fix that makes a previously-dead code path live can surface
  latent bugs in that path. When enabling something that was effectively off,
  exercise the newly-reachable path.
