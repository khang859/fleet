# Fleet

Fleet as in Space Fleet.

A lightweight, cross-platform terminal multiplexer desktop app for developers running multiple AI coding agents simultaneously.

## Stack

Electron + electron-vite + React + TypeScript, xterm.js for terminal emulation, node-pty for PTY processes, Radix UI + Tailwind v4 for UI chrome, Zustand for renderer state, better-sqlite3 for local storage, Vitest for tests.

## Learnings

Past mistakes and fixes are documented in `docs/learnings/`. **After every mistake or unexpected bug, write down what happened and how it was fixed in a new or existing learnings file.** This prevents repeating the same mistakes. Always research (GitHub issues, Context7 docs) before attempting random fixes.

## Verification Commands

- **Type check:** `npm run typecheck` (runs both `typecheck:node` and `typecheck:web`)
- **Lint:** `npm run lint`
- **Test:** `npm test` (Vitest, one run) or `npm run test:watch`. Tests live in `__tests__/` folders next to the source.
- **Format:** `npm run format` (Prettier)
- **Build:** `npm run build` (copies pdfjs assets, runs typecheck, then electron-vite build)

`npm test` rebuilds `better-sqlite3` for Node, and `npm run dev` rebuilds it for Electron.
Expect a short rebuild each time you switch between the two.

CI (`.github/workflows/ci.yml`) runs `npm run build:hook`, the Go hook tests (`cd hooks/fleet-copilot-go && go test ./...`), typecheck, lint, and `npm test`.

## Project Layout

- `src/main` - Electron main process (`agent/`, `copilot/`, `learnings/`, `remote-ssh/`, `sessions/`, `env-sync/`, ...)
- `src/preload` - preload scripts (`index`, `copilot`, `annotate`)
- `src/renderer/src` - React UI (`components/`, `store/`, `hooks/`, `lib/`)
- `src/shared` - types and constants shared by all processes
- `hooks/fleet-copilot-go` - Go hook binary that Claude Code calls, built by `npm run build:hook`
- `openspec/` - OpenSpec change proposals and specs

## Commits

Use conventional commits with a scope, e.g. `feat(agent): ...`, `fix(terminal): ...`, `perf(renderer): ...`.
Changes land as squashed PRs.

## Codebase Questions (ripwire first)

`ripwire` is on PATH and re-indexes this whole repo in under half a second, so its answers are never stale and cover `scripts/` too, not just `src/`.
Reach for it before Grep/Glob, and before opening more than two files to work something out.
The bundled `ripwire-*` skills in `~/.claude/skills` document each verb; `/ripwire-router` maps a moment to the right skill.

Use ripwire for symbol-level and change-level questions:

| Question                                | Command                                                |
| --------------------------------------- | ------------------------------------------------------ |
| Cold start on the repo or one subsystem | `ripwire .` or `ripwire src/main/agent`                |
| Context for a specific task             | `ripwire . --for="<task>"`                             |
| Who calls this, and what does it call   | `ripwire . --callers=SYM` / `--callees=SYM`            |
| Blast radius before changing a symbol   | `ripwire . --impact=SYM`                               |
| Which tests my diff should run          | `ripwire . --affected`                                 |
| Did my edit change a contract           | `ripwire . --edit-check=SYM`                           |
| Does a helper for this already exist    | `ripwire . --exemplar="<what you are about to write>"` |

Run `ripwire . --quality-delta` before calling any non-trivial change done.
It reports only what the change made worse and exits non-zero on new complexity, duplication, or dead code.

Fall back to grep for literal strings, for targets outside the index, and when ripwire comes back thin.

## Driving the UI (fleet-drive)

To see and control the running app during development, use `fleet-drive`. From the repo root:

- `npm run drive -- up` - start this checkout's `npm run dev` detached and wait for the window (`stop` / `restart` too)
- `npm run drive -- screenshot` - JPEG of the live window to `.fleet-drive/screenshots/` (read it to _see_ the UI; `--png` for lossless)
- `npm run drive -- snapshot --refs` - ARIA tree with `[ref=eN]`; pass a ref to `click`/`type` as the selector
- `npm run drive -- click '<sel>'` / `type '<sel>' '<text>'` / `keys 'Meta+K'` - add `--shot` to get a screenshot of the result
- `npm run drive -- eval '<js>'` - runs in the renderer; `__FLEET__.stores.<name>.getState()` reads live zustand state
- `npm run drive -- cmd [id]` - list or run command-palette commands
- `npm run drive -- term-send '<text>' --enter` / `term-key ctrl-c` / `term-wait '<regex>'` / `term` - drive a terminal pane, e.g. run Claude Code in it
- `npm run drive -- run <file>` - many verbs in one call, one per line

A background daemon keeps the connection warm, so a call takes about 60 ms with `node scripts/drive/client.mts <verb>` (the npm form adds about 100 ms).
Only one `npm run dev` runs per checkout: a second one exits with the running one's pid instead of opening another window.

Selectors are Playwright `page.locator()` syntax: `role=button[name="Chat"]`, `text=Settings`, CSS, `testid=<id>`, or a snapshot ref. It attaches over CDP to the dev window (dev-only, enabled in `src/main/index.ts` behind `IS_FLEET_DEV`) - no macOS Screen Recording permission needed, since capture goes through Chromium's compositor, not the OS. This is the correct way to visually verify UI changes yourself. Full details: `scripts/drive/README.md`.

## Release Notes

Before creating a release tag, always add a `## vX.Y.Z` entry to `CHANGELOG.md` and push it to main. The CI release workflow runs `scripts/extract-release-notes.ts` on checkout of the tag - if the changelog entry is missing the build fails. The tag must point to a commit that already includes the changelog entry; if the tag is created before the changelog commit, delete and re-create the tag at the correct commit:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Copilot Mascot Sprites

The copilot supports multiple selectable mascots. Each mascot is a horizontal WebP sprite sheet of 128×128px frames stored in `resources/mascots/`.
Most mascots have 9 frames (1152×128px) with the default layout `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`.
A mascot with a different frame count or layout sets its own `animations` in `src/shared/mascots.ts` (e.g. `dragon` has 11 frames).

To add or update a mascot sprite sheet (the script takes any number of frames):

```bash
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> img0.png img1.png ... img8.png
# or from a directory of 9+ images (sorted by name):
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/
```

This outputs `resources/mascots/<mascot-id>.webp`. Then register the mascot in `src/shared/mascots.ts`.

**Generating mascot frames workflow:**

1. **Generate frame 0** with whatever image model you have to hand (the Agent pane's image tool works). Include "solid bright blue #0000FF chroma key background" in the prompt. Keep the mascot Fleet-themed (naval/officer aesthetic, teal/navy colors).
2. **Generate frames 1-8** using frame 0 as a style reference so the character stays consistent. Describe the pose for each frame's state.
3. **Remove backgrounds** on all 9 frames.
4. **Assemble** into sprite sheet: `npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/`

Do NOT use PixelLab MCP tools (`create_character`, etc.) - the results are poor for this use case.

## Development Notes

- **Module output:** The main process outputs ESM (`.mjs`), so use `import.meta.url` instead of `__dirname` there. Preload scripts output CommonJS.
- **node-pty macOS bug:** `spawn-helper` needs `chmod +x` - handled by postinstall script.
- **xterm.js + StrictMode:** Track PTY creation in a module-level Set to prevent duplicates. The terminal renders with xterm's default DOM renderer - no Canvas/WebGL addon is used (rendering addons caused disposal errors on teardown).
- **xterm.js container sizing:** Mount xterm into an inner div, put padding on an outer wrapper div. Otherwise `fit` addon miscalculates dimensions.

## Behavioral Guidelines

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
