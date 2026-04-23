# Fleet

Fleet as in Space Fleet.

A lightweight, cross-platform terminal multiplexer desktop app for developers running multiple AI coding agents simultaneously.

## Stack

Electron + electron-vite + React + TypeScript, xterm.js for terminal emulation, node-pty for PTY processes, shadcn/ui + Tailwind for UI chrome.

## Learnings

Past mistakes and fixes are documented in `docs/learnings/`. **After every mistake or unexpected bug, write down what happened and how it was fixed in a new or existing learnings file.** This prevents repeating the same mistakes. Always research (GitHub issues, Context7 docs) before attempting random fixes.

## Verification Commands

- **Type check:** `npm run typecheck` (runs both `typecheck:node` and `typecheck:web`)
- **Lint:** `npm run lint`
- **Build:** `npm run build` (runs typecheck first, then electron-vite build)

## Release Notes

Before creating a release tag, always add a `## vX.Y.Z` entry to `CHANGELOG.md` and push it to main. The CI release workflow runs `scripts/extract-release-notes.ts` on checkout of the tag — if the changelog entry is missing the build fails. The tag must point to a commit that already includes the changelog entry; if the tag is created before the changelog commit, delete and re-create the tag at the correct commit:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Copilot Mascot Sprites

The copilot supports multiple selectable mascots. Each mascot is a 9-frame horizontal WebP sprite sheet (1152×128px) stored in `resources/mascots/`. Frame layout: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`.

To add or update a mascot sprite sheet from 9 source images:

```bash
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> img0.png img1.png ... img8.png
# or from a directory of 9+ images (sorted by name):
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/
```

This outputs `resources/mascots/<mascot-id>.webp`. Then register the mascot in `src/shared/mascots.ts`.

**Generating mascot frames workflow:**

1. **Generate frame 0** with `fleet images generate` — establish the character style. Include "solid bright blue #0000FF chroma key background" in the prompt. Keep the mascot Fleet-themed (naval/officer aesthetic, teal/navy colors).
2. **Generate frames 1-8** with `fleet images edit --images <frame-0-path>` — use the first frame as a style reference to maintain consistency. Describe the pose for each frame's state.
3. **Remove backgrounds** on all 9 frames: `fleet images action remove-background <path>` (uses BRIA RMBG 2.0).
4. **Assemble** into sprite sheet: `npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/`

Do NOT use PixelLab MCP tools (`create_character`, etc.) — the results are poor for this use case. Stick to `fleet images` for generation and editing.

All `fleet images` commands are async — use `fleet images status <id>` to poll. Don't sleep-wait; just check status when needed.

## Development Notes

- **ESM output:** The main and preload processes output ESM (`.mjs`). Use `import.meta.url` instead of `__dirname`.
- **node-pty macOS bug:** `spawn-helper` needs `chmod +x` — handled by postinstall script.
- **xterm.js + StrictMode:** Track PTY creation in a module-level Set to prevent duplicates. Use Canvas addon (not WebGL) to avoid disposal errors.
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
