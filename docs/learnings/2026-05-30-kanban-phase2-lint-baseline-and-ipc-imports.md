# Kanban Phase 2: dirty lint baseline + banned inline `import()` types

Captured while implementing the Kanban Board UI (`docs/superpowers/plans/2026-05-30-kanban-phase2-board-ui.md`).

## 1. The repo's lint baseline is NOT clean — don't gate on "lint clean"

### What happened
The Phase 2 plan specified `npm run lint` → "Expected: clean" as a verification gate. In reality, `main` (commit `cb3f4ae`) already had **169 errors / 147 warnings** (`✖ 316 problems`). Most live in `src/main/kanban/kanban-store.ts` itself — the Phase 1 store uses the `db.prepare(...).all() as { ... }[]` pattern ~40 times, which trips `@typescript-eslint/no-unsafe-type-assertion` and `@typescript-eslint/array-type` on every call.

### Takeaway
`npm run typecheck` and `npm run build` and `npm test` are the real gates here; lint is advisory and the baseline is dirty. When a plan says "lint clean," verify the baseline first (`git stash`/checkout the branch point, run `npx eslint .`, compare `✖` totals). The standard to hold is **"add zero NEW errors,"** not "zero errors." New `listBoard` code that matches the file's pervasive existing `.all() as X[]` style was left as-is per CLAUDE.md "match existing style" — fixing only those 4 while 40 identical ones remain would make the method an inconsistent outlier.

To measure the delta: count `✖ N problems` at the branch point vs. HEAD; lint only your changed files with `npx eslint <files>` to see which findings are yours.

## 2. Inline `import('./x').Type` is banned by `@typescript-eslint/consistent-type-imports`

### What happened
The plan's Task 4 snippet wrote payload types as `fields: import('./kanban-types').UpdateTaskFields` to "avoid touching the import block." ESLint rejects this with `` `import()` type annotations are forbidden `` (an **error**, not a warning).

### Fix
Use a top-level `import type { UpdateTaskFields, TaskStatus } from './kanban-types';` and reference the bare names. This matches every other file in `src/shared/`.

### Takeaway
This codebase enforces top-level type imports. Never use the inline `import('...').Type` form — even when it seems convenient to skip editing the import block.

## 3. New tab types need icon branches in TWO sidebars

Adding a `'kanban'` tab type to `Tab.type` is not enough for a finished feature: the collapsed mini-sidebar (`src/renderer/src/App.tsx`, ~line 674) and the full sidebar (`src/renderer/src/components/Sidebar.tsx`, ~line 1177) both pick a tab icon by `tab.type` and fall through to `<Terminal />` for anything unrecognized. A new tab type silently renders as a terminal icon until you add an explicit branch (the `'pi'` type had the same gap). Add a `tab.type === 'kanban'` branch in both when introducing a new tab type.
