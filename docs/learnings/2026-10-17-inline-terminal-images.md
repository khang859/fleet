# Learnings: inline images in the terminal (2026-10-17)

Issue #650. xterm.js draws Sixel and iTerm2 inline images only when `@xterm/addon-image` is loaded.
Fleet loaded fit, search, serialize and unicode11, so image tools fell back to colored half-blocks.

## What changed

- `use-terminal.ts` loads `ImageAddon` with `storageLimit: 32` (MB per pane). The addon default is 128 MB, which adds up fast with many panes.
- The program picks the image size. Fleet does not shrink images, because TUI apps (ratatui-image, eva) place images in exact cells.
- `PtyManager` sets `COLORTERM=truecolor`, `TERM_PROGRAM=Fleet` and `TERM_PROGRAM_VERSION`. They replace inherited values, because a dev launch from iTerm2 would otherwise tell programs they run in iTerm2.
- The addon answers DA1 with the Sixel attribute, so tools like chafa can detect Sixel without `TERM_PROGRAM`.

## Testing without image tools installed

- Sixel: `magick photo.png sixel:-` (ImageMagick writes Sixel directly).
- iTerm2: print `ESC ] 1337 ; File=inline=1;size=<n>:<base64> BEL` from a few lines of Python.
- Drive it with `npm run drive -- term-send '<cmd>' --enter`, then `screenshot`.

## Measuring the addon's parse cost

There is no checked-in terminal benchmark script.
A fair check is two fresh twin terminals in the renderer, built from `terminalRegistryForDev`'s `Terminal` constructor, one with the addon and one without, both writing the same string.
Comparing against a live pane is not fair: the live pane has link providers and parser hooks the twin lacks, which made the addon look 40% slower.
In `drive eval`, a bare `/node_modules/.vite/deps/...` import fails; use the `/@fs/<abs path>?v=<hash>` URL from `performance.getEntriesByType('resource')`.
Result: 4.3 MB of truecolor output, median 90 ms without the addon and 94 ms with it.
