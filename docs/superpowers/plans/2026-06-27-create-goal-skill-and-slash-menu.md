# Create-Goal Skill + Slash-Menu Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bundled `create-goal` chat skill that writes a structured goal doc to `docs/goals/`, and fix the `/` slash menu so it never silently renders nothing.

**Architecture:** `create-goal` is a pure-instructions `SKILL.md` under a new `resources/chat-skills` bundled root (registered in `src/main/index.ts`); it reuses the existing `write_file` tool. The slash-menu fix extracts the menu's open/match/empty decision into a pure helper (`composer-slash.ts`, mirroring the existing `composer-keys.ts`), unit-tests it, and wires it into `Composer.tsx` with an empty-state row and guarded keyboard handling.

**Tech Stack:** Electron + React + TypeScript, Vitest (node environment — no jsdom), the existing `SkillManager` / `SKILL.md` system.

## Global Constraints

- Vitest runs with `environment: 'node'` (see `vitest.config.ts:7`). No DOM/testing-library — renderer logic must be tested as pure functions, not by rendering components.
- No unsafe type assertions (`as`) or `eslint-disable` in `src/`. Use real types.
- Bundled skill state defaults to `on` when absent from the settings overlay.
- Gates that must pass before any task is "done": `npm run typecheck` and `npm run lint`.
- Conventional-commit messages. Commit at the end of each task.
- The Pi agent reads `resources/pi-skills` only; chat skills go under `resources/chat-skills` and must not be added to `pi-agent-manager`.

---

### Task 1: Bundled `create-goal` skill + new chat-skills root

**Files:**
- Create: `resources/chat-skills/create-goal/SKILL.md`
- Modify: `src/main/index.ts` (the `chatSkills` roots array, ~lines 1350-1361)
- Test: `src/main/__tests__/chat-skills.test.ts`

**Interfaces:**
- Consumes: existing `SkillManager` (`src/main/chat/skills/skill-manager.ts`), `scanSkillsDir` (`skill-loader.ts`), `SkillRoot` type.
- Produces: a discoverable bundled skill named `create-goal` available in chat's `/` menu, system prompt, and `load_skill`.

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/chat-skills.test.ts`:

```ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillManager, type SkillRoot } from '../chat/skills/skill-manager';

const CHAT_SKILLS_DIR = join(process.cwd(), 'resources', 'chat-skills');

describe('bundled chat skills', () => {
  it('every folder has a parseable, discoverable SKILL.md', () => {
    const names = readdirSync(CHAT_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(names.length).toBeGreaterThan(0);

    const roots: SkillRoot[] = [{ root: CHAT_SKILLS_DIR, scope: 'bundled' }];
    const mgr = new SkillManager(
      () => roots,
      () => ({})
    );
    mgr.rescan();
    const discovered = mgr.menuItems().map((m) => m.name);
    // Every folder under chat-skills must parse into a discovered skill.
    for (const name of names) expect(discovered).toContain(name);
  });

  it('ships create-goal default-on with a goal-doc description', () => {
    const roots: SkillRoot[] = [{ root: CHAT_SKILLS_DIR, scope: 'bundled' }];
    const mgr = new SkillManager(
      () => roots,
      () => ({})
    );
    mgr.rescan();
    const goal = mgr.statuses().find((s) => s.name === 'create-goal');
    expect(goal).toBeDefined();
    expect(goal?.state).toBe('on');
    expect(goal?.scope).toBe('bundled');
    expect(goal?.description.toLowerCase()).toContain('docs/goals');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/chat-skills.test.ts`
Expected: FAIL — `readdirSync` throws (directory `resources/chat-skills` does not exist).

- [ ] **Step 3: Create the skill file**

Create `resources/chat-skills/create-goal/SKILL.md`:

```markdown
---
name: create-goal
description: >-
  Turn a rough idea into a structured goal document saved to docs/goals/YYYY-MM-DD-<slug>.md. Use when the user wants to "create a goal", "define an objective", "scope this work", "write up a goal", or turn a vague idea into something concrete with success criteria. Pass the idea as the argument. Examples: /skill:create-goal, /create-goal add dark mode to settings, /create-goal cut cold-start time in half.
---

# Create Goal

Your job is to turn the user's idea into a clear, structured goal document and
save it to disk. The output is a markdown file the user (or another agent) can
later turn into a plan or a swarm. Do not start implementing the idea — define
it.

This skill assumes the user is running you inside a working tree. If you cannot
write to `docs/goals/`, tell the user and stop.

## Inputs

- **The idea.** The text the user typed after the invocation (shown as
  `User: <arg>` below). If it is empty, ask one question: "What's the goal?"
  and wait for an answer before continuing.

## Protocol

Three phases, in order.

### Phase 1 — Understand

Read the idea. Restate the intended outcome to yourself in one sentence. If that
sentence is already clear and the success criteria are obvious, skip straight to
Phase 3 — do not interrogate a well-specified request.

### Phase 2 — Clarify (only when essentials are missing)

Ask focused questions, one at a time, ONLY for essentials you cannot reasonably
infer:

- **Purpose / who it's for** — why this matters, who benefits.
- **Success criteria** — how we'll know it's done, stated as verifiable checks.
- **Hard constraints** — deadlines, tech limits, things that must not change.
- **Non-goals** — what is explicitly out of scope.

Stop asking as soon as you can write a useful goal. Two or three questions is
usually plenty; never run a long interview.

### Phase 3 — Write

Pick a short kebab-case slug from the goal (e.g. `dark-mode-settings`,
`cold-start-speedup`). Compute the path `docs/goals/YYYY-MM-DD-<slug>.md` where
the date is today (use the injected time context, or call get_current_time if
unsure). If that path already exists, append `-2`, `-3`, … until unique.

Use the `write_file` tool to save the document in the exact shape below. Then
tell the user — in chat — the absolute path you wrote and a one-line summary of
the objective.

## Goal document format

Match this shape exactly. Omit a section only if it genuinely has no content.

```markdown
# <Goal title>

**Date:** YYYY-MM-DD

## Context
<Why this goal exists; the background a fresh reader needs. 2-4 sentences.>

## Objective
<One clear sentence stating the outcome.>

## Success criteria
- <Verifiable check — something you could test or observe.>
- <Verifiable check.>

## Constraints
- <Hard requirement or limitation. Omit the section if there are none.>

## Out of scope
- <Something this goal explicitly does not cover.>

## Suggested first steps
1. <Concrete starting action.>
2. <Concrete starting action.>
```

## What makes a good goal

- The objective is a single sentence describing an outcome, not a task list.
- Success criteria are verifiable ("p95 cold start < 800ms"), not vague
  ("feels faster").
- Out-of-scope is explicit — it's what keeps the goal from sprawling.
- First steps are concrete enough that someone could start tomorrow.

## What to skip

- Do not implement the idea or write code.
- Do not create kanban cards, swarms, or branches — this skill only writes a doc.
- Do not pad the document with filler; an empty section is better than guessed
  content.
```

- [ ] **Step 4: Register the new bundled root in `index.ts`**

In `src/main/index.ts`, find the `chatSkills` roots array (around line 1352):

```ts
      const roots: SkillRoot[] = [
        { root: join(skillsResourcesDir, 'pi-skills'), scope: 'bundled' },
        { root: personalSkillsDir, scope: 'personal' }
      ];
```

Replace it with (adds `chat-skills`; keeps `pi-skills` so `code-review` still appears in chat):

```ts
      const roots: SkillRoot[] = [
        { root: join(skillsResourcesDir, 'chat-skills'), scope: 'bundled' },
        { root: join(skillsResourcesDir, 'pi-skills'), scope: 'bundled' },
        { root: personalSkillsDir, scope: 'personal' }
      ];
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/__tests__/chat-skills.test.ts`
Expected: PASS (both tests green).

- [ ] **Step 6: Run gates**

Run: `npm run typecheck && npm run lint`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add resources/chat-skills/create-goal/SKILL.md src/main/index.ts src/main/__tests__/chat-skills.test.ts
git commit -m "feat(chat): add bundled create-goal skill and chat-skills root"
```

---

### Task 2: Pure slash-menu decision helper

**Files:**
- Create: `src/renderer/src/components/chat/composer-slash.ts`
- Test: `src/renderer/src/components/chat/__tests__/composer-slash.test.ts`

**Interfaces:**
- Consumes: `PromptTemplate` from `src/shared/prompt-types`.
- Produces:
  - `type SlashCommand = { kind: 'skill'; name: string; description: string } | { kind: 'prompt'; name: string; description: string; template: PromptTemplate }`
  - `function slashMenu(text: string, commands: SlashCommand[], dismissed: boolean): { open: boolean; matches: SlashCommand[]; emptyLabel: string | null }`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/chat/__tests__/composer-slash.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slashMenu, type SlashCommand } from '../composer-slash';

const skill = (name: string): SlashCommand => ({
  kind: 'skill',
  name,
  description: `${name} desc`
});

describe('slashMenu', () => {
  it('is closed when the text is not a lone slash token', () => {
    expect(slashMenu('hello', [skill('create-goal')], false).open).toBe(false);
    expect(slashMenu('/create-goal now', [skill('create-goal')], false).open).toBe(false);
    expect(slashMenu('', [skill('create-goal')], false).open).toBe(false);
  });

  it('is closed when dismissed', () => {
    expect(slashMenu('/', [skill('create-goal')], true).open).toBe(false);
  });

  it('opens with all commands on a bare slash', () => {
    const r = slashMenu('/', [skill('create-goal'), skill('code-review')], false);
    expect(r.open).toBe(true);
    expect(r.matches.map((m) => m.name)).toEqual(['create-goal', 'code-review']);
    expect(r.emptyLabel).toBeNull();
  });

  it('filters by prefix, case-insensitively', () => {
    const r = slashMenu('/CRE', [skill('create-goal'), skill('code-review')], false);
    expect(r.matches.map((m) => m.name)).toEqual(['create-goal']);
    expect(r.emptyLabel).toBeNull();
  });

  it('opens with a "no skills yet" label when nothing is installed', () => {
    const r = slashMenu('/', [], false);
    expect(r.open).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.emptyLabel).toBe('No skills yet — manage in Settings');
  });

  it('opens with a "no matching" label when the filter excludes everything', () => {
    const r = slashMenu('/zzz', [skill('create-goal')], false);
    expect(r.open).toBe(true);
    expect(r.matches).toEqual([]);
    expect(r.emptyLabel).toBe('No matching skills');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/components/chat/__tests__/composer-slash.test.ts`
Expected: FAIL with "Cannot find module '../composer-slash'".

- [ ] **Step 3: Write the helper**

Create `src/renderer/src/components/chat/composer-slash.ts`:

```ts
import type { PromptTemplate } from '../../../../shared/prompt-types';

/** A unified `/` menu entry: an installed skill or a saved prompt template. */
export type SlashCommand =
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'prompt'; name: string; description: string; template: PromptTemplate };

export type SlashMenu = {
  /** Whether the menu should be shown. */
  open: boolean;
  /** Commands matching the current slash query (empty when none match). */
  matches: SlashCommand[];
  /** Muted label to show when open with no matches; null when there are matches. */
  emptyLabel: string | null;
};

const SLASH_RE = /^\/([A-Za-z0-9_.-]*)$/;

/**
 * Decide the `/` autocomplete menu state from the composer text. The menu opens
 * whenever the whole input is a lone slash token and the user hasn't dismissed
 * it — even with zero matches, so the user always gets feedback instead of a
 * silently-empty popover.
 */
export function slashMenu(text: string, commands: SlashCommand[], dismissed: boolean): SlashMenu {
  const m = SLASH_RE.exec(text);
  if (!m || dismissed) return { open: false, matches: [], emptyLabel: null };
  const query = m[1].toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().startsWith(query));
  const emptyLabel =
    matches.length > 0
      ? null
      : commands.length === 0
        ? 'No skills yet — manage in Settings'
        : 'No matching skills';
  return { open: true, matches, emptyLabel };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/components/chat/__tests__/composer-slash.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Run gates**

Run: `npm run typecheck && npm run lint`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/chat/composer-slash.ts src/renderer/src/components/chat/__tests__/composer-slash.test.ts
git commit -m "feat(chat): pure slash-menu decision helper with empty state"
```

---

### Task 3: Wire the helper into the Composer

**Files:**
- Modify: `src/renderer/src/components/chat/Composer.tsx`

**Interfaces:**
- Consumes: `slashMenu`, `SlashCommand` from `./composer-slash` (Task 2).
- Produces: no exported API change; the composer now opens the menu with an empty state and guards keyboard handling.

> No automated test — Vitest is node-only and the Composer isn't render-testable. The decision logic is covered by Task 2; this task is verified by typecheck, lint, and the manual smoke checklist at the end.

- [ ] **Step 1: Replace the local `CommandItem` type and import the helper**

At the top of `Composer.tsx`, the existing import of `PromptTemplate` stays. Add the helper import near the other local imports (after the `composer-keys` import on line 8):

```ts
import { slashMenu, type SlashCommand } from './composer-slash';
```

Delete the local `CommandItem` union (lines 12-15):

```ts
/** A unified `/` menu entry: an installed skill or a saved prompt template. */
type CommandItem =
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'prompt'; name: string; description: string; template: PromptTemplate };
```

(`SlashCommand` from the helper replaces it. The `extractPromptVars` / `fillTemplate` imports on line 6 stay.)

- [ ] **Step 2: Replace the menu state derivation**

Replace the block at lines 58-72:

```ts
  const commands: CommandItem[] = [
    ...skillMenu.map((s) => ({ kind: 'skill' as const, name: s.name, description: s.description })),
    ...promptTemplates.map((p) => ({
      kind: 'prompt' as const,
      name: p.name,
      description: p.description,
      template: p
    }))
  ];
  const slashMatch = /^\/([A-Za-z0-9_.-]*)$/.exec(text);
  const matches = slashMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashMatch[1].toLowerCase()))
    : [];
  const menuOpen = matches.length > 0 && !menuDismissed;
  const activeIndex = Math.min(menuIndex, matches.length - 1);
```

with:

```ts
  const commands: SlashCommand[] = [
    ...skillMenu.map((s) => ({ kind: 'skill' as const, name: s.name, description: s.description })),
    ...promptTemplates.map((p) => ({
      kind: 'prompt' as const,
      name: p.name,
      description: p.description,
      template: p
    }))
  ];
  const menu = slashMenu(text, commands, menuDismissed);
  const matches = menu.matches;
  const menuOpen = menu.open;
  const activeIndex = Math.min(menuIndex, matches.length - 1);
```

- [ ] **Step 3: Update `pickCommand`'s parameter type**

On line 78, change the signature from `CommandItem` to `SlashCommand`:

```ts
  const pickCommand = (cmd: SlashCommand): void => {
```

(The body is unchanged.)

- [ ] **Step 4: Guard the keyboard handler against an empty menu**

In the `onKeyDown` handler, the `if (menuOpen) { ... }` block (lines 431-452) currently assumes `matches.length > 0`. Replace that block with:

```ts
            if (menuOpen) {
              if (e.key === 'Escape') {
                e.preventDefault();
                setMenuDismissed(true);
                return;
              }
              if (matches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMenuIndex((i) => (i + 1) % matches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickCommand(matches[activeIndex]);
                  return;
                }
              }
              // Empty menu: fall through so Enter sends and arrows move the caret.
            }
```

- [ ] **Step 5: Render an empty-state row**

In the menu `<ul>` (lines 375-403), add an empty-state `<li>` after the `{matches.map(...)}` block, inside the same `<ul>`. Replace the closing of the map / list:

```tsx
            ))}
          </ul>
        )}
```

with:

```tsx
            ))}
            {menu.emptyLabel && (
              <li className="px-3 py-1.5 text-[11px] text-fleet-text-muted">{menu.emptyLabel}</li>
            )}
          </ul>
        )}
```

- [ ] **Step 6: Run gates**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (In particular, the removed `CommandItem` type leaves no dangling references — `PromptTemplate` is still used by `formPrompt` state and `extractPromptVars`.)

- [ ] **Step 7: Run the full renderer test suite to confirm nothing regressed**

Run: `npx vitest run src/renderer/src/components/chat`
Expected: PASS (composer-keys and composer-slash suites green).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/chat/Composer.tsx
git commit -m "fix(chat): show slash menu with empty state instead of nothing"
```

---

## Manual smoke checklist (after Task 3)

Run the app (`npm run dev`) and, in the Chat tool:

1. Type `/` with no further input → the menu opens and lists `create-goal` and `code-review` (and any prompt templates).
2. Type `/zzz` → menu shows **"No matching skills"**.
3. (If you can disable all skills in Settings) with none installed, `/` shows **"No skills yet — manage in Settings"**.
4. With the empty menu showing, press Enter → the message sends (the menu does not swallow the keystroke or crash).
5. Run `/create-goal add a dark mode toggle to settings` → the agent asks at most a couple of clarifying questions, then writes `docs/goals/<today>-<slug>.md`; open it and confirm the template sections (Objective, Success criteria, Out of scope, Suggested first steps) are present and the agent reported the path in chat.

---

## Self-review notes

- **Spec coverage:** create-goal skill (Task 1) ✓; chat-skills bundled root wiring (Task 1) ✓; slash menu opens for any slash token + empty state (Tasks 2-3) ✓; keyboard guard so Enter sends on empty menu (Task 3, Step 4) ✓; tests for skill discovery (Task 1) and menu logic (Task 2) ✓; code-review still loads from pi-skills (Task 1 keeps the root + Task 1 test asserts only chat-skills, manual smoke item 1 checks code-review still shows) ✓.
- **Deferred per spec (not in plan):** mid-message `/` trigger, fuzzy match, swarm/kanban integration.
- **Type consistency:** `SlashCommand` is defined once in `composer-slash.ts` (Task 2) and consumed by `Composer.tsx` (Task 3); `slashMenu(text, commands, dismissed)` signature matches between definition and call site.
