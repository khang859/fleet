# Terminal URLs opened truncated, or with a trailing full stop

## What happened

Cmd/Ctrl+clicking a long URL in a terminal pane opened only its first row.
Shorter URLs at the end of a sentence opened with the `.` or `,` still attached.

## Why

URL links came from `@xterm/addon-web-links` with a custom regex.

- The regex stopped at whitespace, quotes and brackets, and at nothing else, so sentence punctuation after a URL was matched as part of it.
  Excluding brackets outright also cut `https://en.wikipedia.org/wiki/Foo_(bar)` at the `(`.
- The addon only joins rows that xterm wrapped itself (`isWrapped`).
  Claude Code and most TUIs wrap their own output with a real newline and an indent, so xterm sees unrelated rows and the link ended at the first one.
- The addon stops joining after 2048 characters in each direction, which a URL carrying a JWT or a SAML assertion can pass.

None of this is configurable: the package exports only the addon, and the row joining is private to it.

## Fix

Fleet now owns URL detection and the addon is gone.

- `src/shared/terminal-url-detect.ts` matches generously, cuts at the first closing bracket whose opener is not inside the URL, then strips trailing sentence punctuation.
  `=`, `-` and `_` are never stripped, because base64 padding and the last character of a JWT are exactly those.
- `readLogicalLine` in `src/renderer/src/lib/terminal-buffer-text.ts` joins soft-wrapped rows and also hard-wrapped ones: a row that runs to within two cells of the right edge is joined to the next row's text, minus its indentation.
  When the next row is not indented, the row has to fill the last column to be joined.
- `src/renderer/src/lib/terminal-url-links.ts` gives xterm one link per row of a hard-wrapped URL, each opening the whole URL, so the indentation is not underlined.

## Things that were not obvious

- `translateToString(true)` only trims cells nothing was written to.
  Claude Code pads the rows of its prompt box with real spaces, so a hard-wrapped URL there had spaces in the middle until each row was trimmed before joining.
  The reply text is not padded, so testing only that would have missed it.
- The hard-wrap join is a guess.
  A URL that ends exactly at the right edge gets the first word of the next row glued on.
- `shell.openExternal` runs `xdg-open` from `PATH` on Linux.
  Starting the dev app with a logging `xdg-open` first on `PATH` shows exactly which URL a click opened, and which process asked for it, without opening a browser.
- The test buffer used `Array.prototype.at`, which wraps a negative index round to the last row.
  A real buffer has no row -1, so code walking upward from row 0 read the last row in tests only.

## Ctrl+click did nothing at all on Linux

After the detection fixes, a Ctrl+click on a correctly underlined URL still opened nothing on Ubuntu, in the dev build and in the installed one.

`shell.openExternal` runs `xdg-open`, which on GNOME runs `gio open`, which starts the default browser as a child of Fleet.
Fleet's main process has the kernel's no-new-privileges flag set (`NoNewPrivs: 1` in `/proc/<pid>/status`), and every child inherits it.
The default browser was snap Firefox, and `snap-confine` cannot start under that flag: it prints "snap-confine is packaged without necessary permissions and cannot continue" and exits.
`xdg-open` still exits 0, so `shell.openExternal` resolves and nothing is logged anywhere.

`openExternal` in `src/main/safe-external.ts` now asks the desktop portal first on Linux (`org.freedesktop.portal.OpenURI`, through `gdbus`), so the session starts the browser instead of Fleet.
It falls back to `shell.openExternal` when there is no portal or no `gdbus`.
The MCP sign-in page goes through the same function.

Takeaways:

- Every earlier test of the click path swapped `xdg-open` for a logging script, which proved the right URL reached the opener and hid that the real opener did nothing.
  A stand-in for the last step of a path is not a test of that step.
- To see the failure, run `sh -x /usr/bin/xdg-open <url>` with the environment of the app's main process.
- `journalctl --user` shows `Started snap.firefox.firefox-<id>.scope` when a browser launch really happened.
- Claude Code running in a pane is a child of Fleet too, so its own URL opening fails the same way.

## Rows of a hard-wrapped URL stopped being links after the first hover

A link provider must return only links that touch the row xterm asked about.
`Linkifier._removeIntersectingLinks` drops links whose columns overlap, and it works the columns out as if every link sat on the asked row.
The stretches of one hard-wrapped URL, one per row, share their columns, so all but the first were discarded once every provider had answered.
It looked like a flaky click: the link worked until the slower path provider replied.
The synthetic-event tests never caught it, because they clicked before that reply arrived; real mouse input through CDP (`Input.dispatchMouseEvent`) did.

## Ctrl+click opened a URL twice inside Claude Code

Claude Code in fullscreen mode turns mouse tracking on and opens a URL itself on Ctrl+click.
xterm reports the press to the program and activates its own link for the same click, so both opened it.
`createTerminal` now stops the mousedown on `.xterm-screen` when Fleet is about to open the link under the pointer.
xterm's link handling listens on that element and its mouse reporting on the root element above it, so the link still activates and the program never sees the press.
