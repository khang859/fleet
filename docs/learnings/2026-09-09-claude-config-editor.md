# Claude Config editor: four bugs found during implementation

Date: 2026-09-09
Area: `Settings > Claude Config` (`src/renderer/src/components/settings/ClaudeConfig*.tsx`, `src/renderer/src/store/claude-config-store.ts`)

## 1. `npx vitest run` fails with a native module error, `npm test` does not

Running `npx vitest run` produced 38 failures in the learnings tests:

```
better-sqlite3 was compiled against NODE_MODULE_VERSION 140, this version of Node.js requires 141
```

Nothing was wrong with the code.
`package.json` has a `pretest` script that runs `npm run rebuild:node`, and `npx` skips it.

**Fix:** always run `npm test`, never `npx vitest run`.
A task list that says "run `npx vitest run`" should be read as "run the project's test command".

## 2. A store action used the selected scope for every file it read

`load(kind, path)` took the scope from the store, so loading all three scopes for the precedence report read the *same* file three times.
The page then reported that every key was set only in the scope the user happened to be looking at.

**Fix:** made scope an explicit parameter, `load(scope, kind, path, opts)`, matching `save`.
Regression test: `src/renderer/src/store/__tests__/claude-config-store.test.ts`, "reads the scope it was given, not whichever scope the page is showing".

**Rule:** if an action can be called for a target other than the currently selected one, the target belongs in the arguments, not in the store read.

## 3. The Settings tab's own pane reports `cwd: '/'`

The page seeded the project folder from `getActivePaneContext().cwd`.
While Settings is open, the active pane *is* the Settings tab, and its `cwd` is `/`.
So every project path resolved under `/`, and `.claude/settings.local.json` pointed at the filesystem root.

Found by screenshotting the live page with `npm run drive` and reading the store with
`npm run drive -- eval '__FLEET__.stores.claudeConfig.getState()'`.

**Fix:** `firstWorkingDirectory()` in `ClaudeConfigSection.tsx` scans `workspace.tabs` for the first terminal or agent tab and takes its pane `cwd`, ignoring non-directory tabs and `/`.

**Rule:** a non-terminal tab has no meaningful working directory.
Do not ask the active pane for one from inside a settings or preview surface.

## 4. Passing an extracted value to a function that walks the path itself

`describePrecedence(path, values)` walks `path` through each scope's whole parsed settings object.
The form called it through a helper that extracted the value at `path` first, so every scope looked unset and no precedence notice ever rendered.

**Fix:** pass the parsed files.
`ScopeValues` in `src/shared/claude-settings-precedence.ts` is now
`Partial<Record<ClaudeConfigScope, Record<string, unknown>>>`, so making the same mistake again is a type error rather than a silent blank.

**Rule:** when a function takes both a path and a container, tighten the container type so a pre-walked value cannot be passed.

## 5. A Python edit script broke a multi-line import block

A script that inserted an import after "the last line starting with `import`" placed it in the middle of a multi-line `import type { ... }` block in `claude-config-fs.ts`, producing `TS1005`.
The same script also crashed with `max() arg is an empty sequence` on a file with no import line.

**Rule:** for import insertion, anchor on a full known import statement string, not on a line prefix.
Run `npm run typecheck` right after any scripted edit.

## 6. An empty cell reads as a bug, not as a value

Fleet's copilot hook installer writes its `Stop` and `SubagentStop` entries with no `matcher` key at all.
In the hooks table those rows rendered an empty MATCHER cell under a MATCHER header, and the page looked broken.
The data was correct: an absent matcher means the hook runs every time.

**Rule:** a table cell whose value is legitimately absent must say what the absence means.
Locked matcher cells now render a dim `any` instead of nothing.

## 7. Two three-line wrapper components cost five ripwire gating findings

`Notice` and `LinkButton` in `ClaudeConfigSaveBar.tsx` were tiny JSX wrappers.
The clone detector matched each of them against unrelated small components elsewhere in the tree, and `--quality-delta` gating jumped from 4 to 12.
Inlining both, and reusing the existing `parseSettings` instead of writing a local `parse`, brought it back to 5.

**Rule:** below about five lines, a shared class string beats a wrapper component.
The remaining `Group | Row` pair is a shape collision, not a copy, and merging them would be the wrong abstraction.
