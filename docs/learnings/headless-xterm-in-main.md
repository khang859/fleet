# Headless xterm in the main process

## What happened

The main process reads a crew pane's screen through `@xterm/headless`.
Two things broke on the way.

1. `import { Terminal } from '@xterm/headless'` failed at runtime.
   The main process is ESM with external deps, and the package is CommonJS.
   Node's ESM loader cannot see its named exports.
2. Reading `term.buffer.active` threw "You must set the allowProposedApi option".
   xterm counts reading the buffer as proposed API.

## Fix

- Use a default import: `import xtermHeadless from '@xterm/headless'; const { Terminal } = xtermHeadless;`.
- Make the terminal with `allowProposedApi: true`.
- Before reading, flush with `await new Promise((r) => term.write('', r))`, because `write` parses later.

Keep `@xterm/headless` on the same version as `@xterm/xterm`.
