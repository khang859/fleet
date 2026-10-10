# A pane had no locale, so `cd` + Tab showed `cdcd`

**What happened:** In the installed app, typing `cd` and pressing Tab in a zsh pane showed `cd  cd` or `cdcd`.
The dev app did not show it.

**Why:** An app launched from Finder or the Dock gets no `LANG`.
A pane's shell is not a login shell, so `/etc/zprofile` (which sets `LANG=C.UTF-8` when it is empty) never runs.
With `LC_CTYPE=C`, zsh counts the 3 bytes of the `➜` prompt glyph as 3 columns.
xterm draws it as 1 column, so every line redraw (Tab completion) lands 2 columns off.
The dev app is started from a terminal that already has `LANG`, which hides the bug.

**Fix:** `withUtf8Locale` in `src/main/pty-manager.ts` sets `LANG` when `LANG`, `LC_ALL`, and `LC_CTYPE` are all empty.
It uses `en_US.UTF-8` on macOS and `C.UTF-8` on Linux, and leaves Windows alone.

**Reproduce in dev:** run `unset LANG; exec zsh` in a pane, then type `cd` and press Tab.

## The race behind it

`enrichProcessEnv()` merges the login shell environment (which has `LANG`) into `process.env`, but `index.ts` starts it with `void` and it takes about 2 seconds.
A pane restored at launch was created before it finished, so it got launchd's bare environment.
A pane opened later was fine, which made the bug look random.

**Fix:** the `PTY_CREATE` handler now awaits `enrichProcessEnv()`.
`withUtf8Locale` stays as the backstop for a login shell that sets no locale, or a resolution that times out.
