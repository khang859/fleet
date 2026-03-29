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

The copilot supports multiple selectable mascots. Each mascot is a 9-frame horizontal sprite sheet (1152×128px) with this frame layout: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`.

To add or update a mascot sprite sheet from 9 source images:

```bash
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> img0.png img1.png ... img8.png
# or from a directory of 9+ PNGs (sorted by name):
npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/
```

This outputs `sprites-<mascot-id>.ts` (base64 data URI) in the copilot assets folder. Then register the mascot in `src/shared/mascots.ts` and `src/renderer/copilot/src/assets/sprite-loader.ts`.

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
