# Create-Goal Skill + Slash-Menu Fix — Design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan

## Summary

Two changes to the Chat tool:

1. **Ship a bundled `create-goal` skill.** When invoked, the chat agent interviews
   the user about a rough idea and writes a structured goal document to
   `docs/goals/YYYY-MM-DD-<slug>.md`. Pure instructions — no swarm, no kanban, no
   new agent tool. It reuses the existing `write_file` tool.

2. **Fix the `/` slash menu so it is never silently empty.** Today the menu only
   renders when at least one command matches, so typing `/` with no installed
   skills (or a filter that matches nothing) shows *nothing* — no menu, no
   feedback. We open the menu for any slash token and render a muted empty state.

## Context

The Chat tool already has a complete Agent Skills system (`SKILL.md` standard) and
a `/` autocomplete menu. The relevant pieces:

- **Skill discovery:** `src/main/chat/skills/skill-manager.ts` +
  `skill-loader.ts`. Scans roots by scope priority (project > personal > bundled).
  Bundled root is `resources/pi-skills` (wired in `src/main/index.ts:1350-1361`).
- **Existing bundled skill:** `resources/pi-skills/code-review/SKILL.md` — the
  exact template we mirror. It is bundled, default-`on`, invoked as
  `/skill:code-review` or `/code-review`, and writes a dated markdown report to
  `docs/reviews/YYYY-MM-DD-<topic>.md`.
- **Slash menu:** `src/renderer/src/components/chat/Composer.tsx:54-95, 375-460`.
  Commands = installed skills (`skillMenu`) + saved prompt templates
  (`promptTemplates`). Loaded on chat init via `chat-store.init` →
  `loadSkillMenu` → `window.fleet.chat.skillsGet`.
- **Pi isolation:** the Pi agent loads only `code-review` by name
  (`pi-agent-manager.getSkillPaths` → `['code-review']`), so adding a second
  folder under `resources/pi-skills` does **not** leak it to Pi.

## Part 1 — `create-goal` bundled skill

### Location

`resources/pi-skills/create-goal/SKILL.md` — follows the existing bundled-skill
convention, so no `index.ts` root wiring is needed. Default skill state is `on`
(absent overlay entry ⇒ `on`), so it ships enabled and appears in the system
prompt, the `/` menu, and is loadable.

### Frontmatter

Mirrors `code-review`'s style:

- `name: create-goal`
- `description`: a single string that (a) states what the skill does, (b) tells
  the model *when* to auto-trigger ("create a goal", "define an objective",
  "scope this work", "turn this idea into a goal"), (c) notes the output path
  `docs/goals/YYYY-MM-DD-<slug>.md`, and (d) gives example invocations
  (`/skill:create-goal`, `/create-goal <idea>`).
- `allowed-tools`: `write_file` (and `read_file` if it needs to inspect the repo
  for context).

### Body (instructions)

1. **Read the user's idea** passed after the invocation (the text following
   `/create-goal`). If empty, ask what the goal is about.
2. **Clarify only if underspecified.** Ask focused questions *only* for missing
   essentials: purpose, who/what it's for, success criteria, hard constraints,
   and explicit non-goals. Do not interrogate a well-specified request — go
   straight to writing.
3. **Write the goal doc** with `write_file` to
   `docs/goals/YYYY-MM-DD-<slug>.md`, where `<slug>` is a short kebab-case
   summary and the date is today's date (available from the injected time
   context / `get_current_time`).
4. **Report the path** and a one-line summary of what was written.

### Goal-doc template

```markdown
# <Goal title>

**Date:** YYYY-MM-DD

## Context
<Why this goal exists; background a reader needs.>

## Objective
<One clear sentence stating the outcome.>

## Success criteria
- <Verifiable bullet>
- <Verifiable bullet>

## Constraints
- <Hard requirement / limitation>

## Out of scope
- <What this goal explicitly does not cover>

## Suggested first steps
1. <Concrete starting action>
```

## Part 2 — Slash-menu fix (`Composer.tsx`)

### Root cause

`Composer.tsx:71`:

```ts
const menuOpen = matches.length > 0 && !menuDismissed;
```

When `matches` is empty (no installed commands, or filter matches none), the menu
never opens and the user gets no feedback.

### Change

- **Detect "slash mode":** the input is a slash token (the existing
  `slashMatch` regex `/^\/([A-Za-z0-9_.-]*)$/` already computes this).
- **Open the menu whenever in slash mode and not dismissed**, regardless of match
  count: `menuOpen = !!slashMatch && !menuDismissed` (still suppressed while the
  `@` mention menu is open, matching current behavior).
- **Render an empty-state row** when `matches.length === 0`:
  - If the command list is entirely empty → *"No skills yet — manage in
    Settings."*
  - Otherwise (filter matched nothing) → *"No matching skills."*
  - The row is muted and non-interactive (no `onMouseDown` pick handler).
- **Guard the keyboard path:** when `matches.length === 0`, ArrowUp/ArrowDown are
  no-ops and Enter/Tab must fall through to normal send (never attempt to pick a
  nonexistent `matches[activeIndex]`). `pickCommand` is only reachable with a real
  match.
- **Styling:** reuse the existing dropdown `<ul>` container and item classes; the
  empty-state is a single muted `<li>`. No visual redesign.

### Explicitly deferred (YAGNI)

- Mid-message `/` triggering (today only fires when the slash is the whole input).
  Matches how `code-review` is already used; not requested.
- Fuzzy matching / preview cards.

## Out of scope

- No swarm/kanban integration; `create-goal` does **not** create a `SwarmInput`
  or kanban card.
- No new agent tool, no `fleet` CLI command, no new skill root, no settings-UI
  changes.

## Testing / verification

- **Skill loads:** add a unit assertion (or extend the existing skill-manager
  tests) that `create-goal` is discovered from the bundled root and appears in
  `menuItems()` / `statuses()` with state `on`.
- **Skill shape:** `create-goal/SKILL.md` parses (valid frontmatter with
  `name`/`description`); covered by the existing loader behavior.
- **Slash menu:** component/unit coverage that (a) typing `/` with an empty
  command list opens the menu and shows the empty-state copy, (b) a filter that
  matches nothing shows "No matching skills", (c) Enter with an empty menu sends
  rather than picking.
- **Manual smoke:** in the Chat tool, type `/`, confirm `create-goal` (and
  `code-review`) appear; run `/create-goal <idea>`, confirm a file lands at
  `docs/goals/<date>-<slug>.md` with the template sections.
- **Gates:** `npm run typecheck` and `npm run lint` pass.

## Files touched

- **New:** `resources/pi-skills/create-goal/SKILL.md`
- **Edit:** `src/renderer/src/components/chat/Composer.tsx` (menu-open gate,
  empty-state row, keyboard guards)
- **Test:** extend skill-manager and/or composer tests as above
