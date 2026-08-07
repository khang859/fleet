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

## Knowledge Graph (graphify)

`graphify-out/` holds a committed knowledge graph of `src/`, so a fresh clone can answer architecture questions without building anything.
Query it with `/graphify query "<question>"` rather than rebuilding - the graph is already there.
`GRAPH_REPORT.md` carries the god nodes, community map, and import cycles; `graph.html` is the interactive view.

**Refresh on a cadence, not on every change.** Regenerate at releases, or when the graph has drifted far enough to give wrong answers - not as a routine step after editing code.
The reason is that Louvain clustering is nondeterministic: a rebuild that finds no code changes still reassigns ~80% of nodes to different communities, so every refresh is a ~6,000-line diff and two branches that both rebuild will conflict irreconcilably.
`.gitattributes` marks these files generated so review collapses them, but that hides the noise rather than removing it.

Two gotchas when you do refresh:

- The bare `graphify update` CLI **overwrites the curated community labels** with mechanical ones (`Reported Activity` becomes `ReportedActivity`). Refresh through the `/graphify` skill so the labelling step reruns, and check `GRAPH_REPORT.md` before committing.
- `graphify-out/.graphify_root` points at `src`, so a bare `graphify update` writes a stray `src/graphify-out/` directory. Delete it if it appears; it is not the real output.

`graph.json` is 7.8 MB (about 360 KB compressed in git). Only `cost.json`, `cache/`, and the two absolute-path `.graphify_*` files are ignored.

## Driving the UI (fleet-drive)

To see and control the running app during development, use `fleet-drive`. Start `npm run dev`, then from the repo root:

- `npm run drive -- screenshot` — PNG of the live window to `.fleet-drive/screenshots/` (read it to *see* the UI)
- `npm run drive -- snapshot` — ARIA tree (text sense of what's on screen)
- `npm run drive -- click '<sel>'` / `type '<sel>' '<text>'` / `keys 'Meta+K'`
- `npm run drive -- eval '<js>'` — runs in the renderer; `__FLEET__.stores.<name>.getState()` reads live zustand state

Selectors are Playwright `page.locator()` syntax: `role=button[name="Chat"]`, `text=Settings`, CSS, or `testid=<id>`. It attaches over CDP to the dev window (dev-only, enabled in `src/main/index.ts` behind `IS_FLEET_DEV`) — no macOS Screen Recording permission needed, since capture goes through Chromium's compositor, not the OS. This is the correct way to visually verify UI changes yourself. Full details: `scripts/drive/README.md`.

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

1. **Generate frame 0** with whatever image model you have to hand (the Agent pane's image tool works). Include "solid bright blue #0000FF chroma key background" in the prompt. Keep the mascot Fleet-themed (naval/officer aesthetic, teal/navy colors).
2. **Generate frames 1-8** using frame 0 as a style reference so the character stays consistent. Describe the pose for each frame's state.
3. **Remove backgrounds** on all 9 frames.
4. **Assemble** into sprite sheet: `npx tsx scripts/assemble-copilot-sprites.ts <mascot-id> path/to/frames/`

Do NOT use PixelLab MCP tools (`create_character`, etc.) - the results are poor for this use case.

## Development Notes

- **ESM output:** The main and preload processes output ESM (`.mjs`). Use `import.meta.url` instead of `__dirname`.
- **node-pty macOS bug:** `spawn-helper` needs `chmod +x` — handled by postinstall script.
- **xterm.js + StrictMode:** Track PTY creation in a module-level Set to prevent duplicates. The terminal renders with xterm's default DOM renderer — no Canvas/WebGL addon is used (rendering addons caused disposal errors on teardown).
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
