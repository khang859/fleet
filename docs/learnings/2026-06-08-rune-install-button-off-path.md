# Learnings: Rune "Install/Update" button installed off-PATH (2026-06-08)

## Problem

After clicking the new Settings → Rune **Update** button (commit `6c0c21e`), running
`rune` in the terminal returned `command not found` — even though the binary had just
been installed successfully.

`RuneManager.installOrUpdate()` runs the upstream install script via
`sh -c 'curl … | install.sh'`. That script chooses its install directory like this:

```sh
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  install_dir="/usr/local/bin"
else
  install_dir="${HOME}/.local/bin"
```

On a Homebrew-on-arm64 Mac, `/usr/local/bin` exists and is writable but is **not** on
the user's PATH (Homebrew lives at `/opt/homebrew`). So the binary landed in
`/usr/local/bin/rune`, which the shell never searches. The script prints a "not on your
PATH" warning, but the GUI button swallowed stdout, so the user never saw it.

Two failure modes hid in here:
1. Non-deterministic install location depending on what dirs happen to be writable.
2. PATH mismatch: Fleet probes `rune --version` using the main process's PATH, which can
   differ from the user's interactive shell — so Fleet could report "✅ installed" while
   the terminal couldn't find it.

## Fix

Pin the install dir to `~/.fleet/bin` by passing `RUNE_INSTALL_DIR` to the script
(`install.sh` honors that env var):

```ts
const RUNE_INSTALL_DIR = join(homedir(), '.fleet', 'bin');
await execFileAsync('sh', ['-c', RUNE_INSTALL_COMMAND], {
  timeout: INSTALL_TIMEOUT_MS,
  env: { ...process.env, RUNE_INSTALL_DIR }
});
```

`~/.fleet/bin` is the one directory Fleet guarantees is on PATH: `index.ts` prepends it
to `process.env.PATH` at startup, and `install-fleet-cli.ts` appends it to every shell
profile. Installing there keeps the version probe, the Kanban dispatcher's
`spawn('rune')`, and the user's interactive terminal all in agreement.

## Takeaway

When shelling out to a third-party install script from Electron, never rely on its
default install-dir heuristics — they assume an interactive shell's PATH. Pin the target
to a directory the app already controls and keeps on PATH.
