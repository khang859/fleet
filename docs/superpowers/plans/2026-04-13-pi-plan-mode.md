# Pi Plan Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude-Code-style plan mode to Pi as a bundled Pi extension — read-only investigation, guided by a prompt-injected protocol, ending with an approved markdown plan written to `docs/plans/`.

**Architecture:** One new Pi extension file (`resources/pi-extensions/fleet-plan-mode.ts`) registered alongside the existing three extensions in `src/main/pi-agent-manager.ts`. The extension uses Pi's `ExtensionAPI` to register a `/plan` slash command, inject a system-prompt addendum while active, block write/exec tools (`write`, `edit`, `bash`, `fleet_run`), and register an `exit_plan_mode` tool that writes the plan file after user approval. Module-scope boolean holds the active flag; resets on `session_start`.

**Tech Stack:** TypeScript, `@mariozechner/pi-coding-agent` ExtensionAPI, `@sinclair/typebox` for tool schema, Node `fs` for file writing. Design reference: `docs/superpowers/specs/2026-04-13-pi-plan-mode-design.md`. Extension API reference: `~/.fleet/agents/pi/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`.

**Notes on testing:**

- Pi extensions are loaded by pi-coding-agent at runtime via jiti — they are **not covered by the repo's `npm run typecheck`** (which only scans `src/main`, `src/preload`, `src/shared`, `src/renderer`). The existing extensions in `resources/pi-extensions/` follow the same pattern and have no automated tests.
- Verification per task is therefore: (a) run `npm run typecheck && npm run lint` to confirm the host-side change in `pi-agent-manager.ts` still compiles, and (b) run `npm run dev` to launch Fleet, open a Pi tab, and exercise the new behavior in the TUI.
- Each task ends with a commit so the history is reviewable.

---

## File Structure

**Create:**

- `resources/pi-extensions/fleet-plan-mode.ts` — single-file extension. Module-scope `planMode` flag, command registration, event handlers, and the `exit_plan_mode` tool. Kept in one file because all logic is tightly coupled around the shared flag and the extension stays under ~200 lines.

**Modify:**

- `src/main/pi-agent-manager.ts:83` — add `'fleet-plan-mode.ts'` to the bundled extensions list.
- `CHANGELOG.md:3-7` — add a bullet under `## [Unreleased]` → `### Added`.

No changes to the renderer, preload, or shared layers — this iteration is Pi-TUI-only per the spec's non-goals.

---

## Task 1: Extension skeleton + /plan command + registration

**Files:**

- Create: `resources/pi-extensions/fleet-plan-mode.ts`
- Modify: `src/main/pi-agent-manager.ts:83`

- [ ] **Step 1: Create the extension file**

Create `resources/pi-extensions/fleet-plan-mode.ts`:

```typescript
/**
 * Fleet Plan Mode Extension for Pi Coding Agent
 *
 * Adds a "plan mode" to Pi. While active, Pi follows an investigation
 * protocol injected into the system prompt, write/exec tools are blocked,
 * and the LLM produces a markdown plan via the `exit_plan_mode` tool.
 * The plan is written to docs/plans/YYYY-MM-DD-<topic>.md after the user
 * approves it.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

const PLAN_MODE_STATUS_KEY = 'plan-mode';
const PLAN_MODE_STATUS_LABEL = '📋 Plan Mode';

let planMode = false;

export default function (pi: ExtensionAPI): void {
  pi.registerCommand('plan', {
    description:
      'Enter plan mode (read-only investigation, ends with an approved markdown plan). Use `/plan cancel` to exit without a plan.',
    handler: async (args, ctx) => {
      const subcommand = (args ?? '').trim();

      if (subcommand === 'cancel') {
        if (!planMode) {
          ctx.ui.notify('Plan mode is not active.', 'info');
          return;
        }
        planMode = false;
        ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, undefined);
        ctx.ui.notify('Plan mode cancelled. No plan was written.', 'info');
        return;
      }

      if (subcommand.length > 0) {
        ctx.ui.notify(
          `Unknown subcommand '${subcommand}'. Use '/plan' or '/plan cancel'.`,
          'warning'
        );
        return;
      }

      if (planMode) {
        ctx.ui.notify('Plan mode is already on.', 'info');
        return;
      }

      planMode = true;
      ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, PLAN_MODE_STATUS_LABEL);
      ctx.ui.notify('Plan mode on — read-only until you approve the plan.', 'info');
    }
  });

  pi.on('session_start', async (_event, _ctx) => {
    planMode = false;
  });
}
```

- [ ] **Step 2: Register the extension in pi-agent-manager**

Open `src/main/pi-agent-manager.ts` and change line 83 from:

```typescript
const extensions = ['fleet-bridge.ts', 'fleet-files.ts', 'fleet-terminal.ts'];
```

to:

```typescript
const extensions = ['fleet-bridge.ts', 'fleet-files.ts', 'fleet-terminal.ts', 'fleet-plan-mode.ts'];
```

- [ ] **Step 3: Typecheck and lint**

Run:

```bash
npm run typecheck && npm run lint
```

Expected: both pass with no errors. (If lint complains about the new file, check the existing `fleet-bridge.ts` / `fleet-files.ts` — they use the same top-of-file comment and import style; match that.)

- [ ] **Step 4: Manual smoke test**

Run:

```bash
npm run dev
```

Open a Pi tab. If Pi is not yet installed, let it install. In the Pi TUI:

1. Type `/plan` and press Enter. Expected: footer shows "📋 Plan Mode", notify says "Plan mode on — read-only until you approve the plan."
2. Type `/plan` again. Expected: notify "Plan mode is already on."
3. Type `/plan cancel`. Expected: footer clears, notify "Plan mode cancelled. No plan was written."
4. Type `/plan cancel` again. Expected: notify "Plan mode is not active."
5. Type `/plan foo`. Expected: warning notify "Unknown subcommand 'foo'. Use '/plan' or '/plan cancel'."

Stop `npm run dev`.

- [ ] **Step 5: Commit**

```bash
git add resources/pi-extensions/fleet-plan-mode.ts src/main/pi-agent-manager.ts
git commit -m "$(cat <<'EOF'
feat(pi): add fleet-plan-mode extension skeleton with /plan command

Empty plan-mode toggle wired into pi-agent-manager. No prompt injection
or tool blocking yet — those come in subsequent commits.
EOF
)"
```

---

## Task 2: Inject system-prompt addendum while plan mode is on

**Files:**

- Modify: `resources/pi-extensions/fleet-plan-mode.ts`

- [ ] **Step 1: Add the addendum constant**

At the top of `resources/pi-extensions/fleet-plan-mode.ts`, below the existing constants (after `PLAN_MODE_STATUS_LABEL`), add:

```typescript
const PLAN_MODE_ADDENDUM = `Plan Mode Investigation Protocol

You are in plan mode. Only read-only tools are available until you call exit_plan_mode. Follow this protocol:

1. Understand the question. Restate the ask in your own words if anything is ambiguous. Identify purpose, constraints, and what "done" looks like.

2. Explore before planning. Read the relevant files yourself — don't guess. Start broad (project structure, related docs, recent commits) then narrow to the specific code paths that will be touched. For bugs, find the root cause before proposing fixes.

3. Check scope. Is this one focused change or multiple independent pieces? If it spans several subsystems, say so and suggest breaking it up before planning.

4. Ask when ambiguous. If purpose, constraints, or success criteria are unclear, ask one question at a time. Prefer multiple-choice. Don't guess and move on.

5. Consider alternatives. Before committing, think through 2–3 options and their trade-offs. Recommend one and say why.

6. Follow existing patterns. Match conventions already in the codebase unless there's a specific reason to deviate. Don't propose unrelated refactoring.

7. YAGNI. Plan only what's asked. No speculative features, flags, or abstractions.

When you have enough that another engineer could execute without asking questions, call exit_plan_mode.`;
```

- [ ] **Step 2: Register the before_agent_start handler**

Inside the default-exported function, after the `pi.on("session_start", ...)` handler, add:

```typescript
pi.on('before_agent_start', async (event, _ctx) => {
  if (!planMode) return;
  return {
    systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_ADDENDUM}`
  };
});
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both pass.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Open a Pi tab. Enable plan mode (`/plan`). Send a prompt like "Add a logging helper to this repo."

Expected: Pi responds by investigating first (reading files, asking questions, summarizing what it found) rather than jumping straight to writing code. The investigation protocol is in the system prompt, so the exact phrasing will vary by model, but the behavior should be clearly research-first.

`/plan cancel` and send the same prompt with plan mode off. Expected: Pi responds more directly (and would attempt to write code if not for us stopping it).

Stop `npm run dev`.

- [ ] **Step 5: Commit**

```bash
git add resources/pi-extensions/fleet-plan-mode.ts
git commit -m "$(cat <<'EOF'
feat(pi): inject plan-mode investigation protocol into system prompt

When plan mode is active, append a 7-point protocol to the system
prompt via before_agent_start: understand, explore, check scope,
ask when ambiguous, consider alternatives, follow existing patterns,
YAGNI.
EOF
)"
```

---

## Task 3: Block write/exec tools while plan mode is on

**Files:**

- Modify: `resources/pi-extensions/fleet-plan-mode.ts`

- [ ] **Step 1: Add the blocked-tools set**

Below `PLAN_MODE_ADDENDUM` (top-of-file constants section), add:

```typescript
const BLOCKED_TOOLS = new Set<string>(['write', 'edit', 'bash', 'fleet_run']);
const PLAN_MODE_BLOCK_REASON =
  'Plan mode is active — this tool is disabled. Use read-only tools to investigate, then call exit_plan_mode with your plan.';
```

- [ ] **Step 2: Register the tool_call handler**

Inside the default-exported function, after the `pi.on("before_agent_start", ...)` handler, add:

```typescript
pi.on('tool_call', async (event, _ctx) => {
  if (!planMode) return;
  if (!BLOCKED_TOOLS.has(event.toolName)) return;
  return { block: true, reason: PLAN_MODE_BLOCK_REASON };
});
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both pass.

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Open a Pi tab. Enable plan mode (`/plan`). Ask Pi to "create a file called scratch.txt with the contents 'hello'".

Expected: Pi attempts to call `write` (or `bash`), the call is blocked, and Pi's next turn shows it received the block reason and adjusts course (e.g., starts reading files instead, or tells the user it can't write while in plan mode).

Disable plan mode (`/plan cancel`). Ask for the same thing. Expected: Pi writes the file normally (or calls `write` without being blocked).

Stop `npm run dev`.

- [ ] **Step 5: Commit**

```bash
git add resources/pi-extensions/fleet-plan-mode.ts
git commit -m "$(cat <<'EOF'
feat(pi): block write/exec tools while plan mode is active

The tool_call handler blocks write, edit, bash, and fleet_run with a
reason string the LLM sees in the tool result, so it self-corrects.
Read-only tools (read, grep, find, ls, fleet_open) pass through.
EOF
)"
```

---

## Task 4: exit_plan_mode tool (writes plan + approval dialog)

**Files:**

- Modify: `resources/pi-extensions/fleet-plan-mode.ts`

- [ ] **Step 1: Add imports**

At the top of the file, below `import type { ExtensionAPI } ...`, add:

```typescript
import { Type } from '@sinclair/typebox';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
```

- [ ] **Step 2: Add schema + helper constants**

Below the existing constants (after `PLAN_MODE_BLOCK_REASON`), add:

```typescript
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PLAN_PREVIEW_LINES = 60;

const ExitPlanModeParams = Type.Object({
  plan: Type.String({
    description:
      'The implementation plan as markdown. Include a short title, brief context, and step-by-step actions with file paths.'
  }),
  topic: Type.String({
    description:
      "Short kebab-case topic used in the filename, e.g. 'pi-plan-mode' or 'fix-pty-leak'. Must match /^[a-z0-9][a-z0-9-]*$/."
  })
});
```

- [ ] **Step 3: Add helper functions**

Below the constants and above the default-exported function, add:

```typescript
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolvePlanPath(cwd: string, topic: string): string {
  const dir = join(cwd, 'docs', 'plans');
  const date = formatDate(new Date());
  let candidate = join(dir, `${date}-${topic}.md`);
  let counter = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${date}-${topic}-${counter}.md`);
    counter++;
  }
  return candidate;
}

function previewPlan(plan: string): string {
  const split = plan.split('\n');
  if (split.length <= PLAN_PREVIEW_LINES) return plan;
  const remaining = split.length - PLAN_PREVIEW_LINES;
  return `${split.slice(0, PLAN_PREVIEW_LINES).join('\n')}\n\n…(${remaining} more lines)`;
}
```

- [ ] **Step 4: Register the exit_plan_mode tool**

Inside the default-exported function, after the `pi.on("tool_call", ...)` handler, add:

```typescript
pi.registerTool({
  name: 'exit_plan_mode',
  label: 'Exit Plan Mode',
  description:
    'Call this when you have a complete plan ready for the user. Writes the plan to docs/plans/YYYY-MM-DD-<topic>.md after the user approves it, then exits plan mode so you can begin executing. Pass the plan as markdown in `plan` and a short kebab-case topic in `topic`.',
  parameters: ExitPlanModeParams,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    if (!planMode) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Plan mode is not active. exit_plan_mode can only be called while in plan mode.'
          }
        ],
        details: undefined
      };
    }

    if (!TOPIC_PATTERN.test(params.topic)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Invalid topic '${params.topic}'. Must be kebab-case matching /^[a-z0-9][a-z0-9-]*$/ (e.g. 'pi-plan-mode').`
          }
        ],
        details: undefined
      };
    }

    const planPath = resolvePlanPath(ctx.cwd, params.topic);
    const body = `Path: ${planPath}\n\n---\n\n${previewPlan(params.plan)}`;
    const approved = await ctx.ui.confirm('Approve plan?', body);

    if (!approved) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'User rejected the plan. Revise based on their feedback and call exit_plan_mode again when ready.'
          }
        ],
        details: undefined
      };
    }

    const dir = join(ctx.cwd, 'docs', 'plans');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(planPath, params.plan, 'utf-8');

    planMode = false;
    ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, undefined);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Plan approved and written to ${planPath}. Plan mode is off — you may now execute the plan.`
        }
      ],
      details: undefined
    };
  }
});
```

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both pass.

- [ ] **Step 6: Manual smoke test — approval path**

```bash
npm run dev
```

Open a Pi tab. Enable plan mode (`/plan`). Ask Pi to "plan how to add a hello-world CLI flag to this repo". Wait for Pi to call `exit_plan_mode`.

Expected:

- A confirm dialog appears titled "Approve plan?" showing the target path (e.g. `/Users/khangnguyen/Development/fleet/docs/plans/2026-04-13-hello-world.md`) and a preview of the plan.
- Approve the dialog. The file is written to disk at the shown path. Footer clears. Pi's next turn shows the "Plan approved and written to …" message.
- Verify the file exists: `ls docs/plans/2026-04-13-hello-world*.md` (adjust date). Contents should be the markdown Pi generated.
- Asking Pi to write code now succeeds (plan mode is off).

- [ ] **Step 7: Manual smoke test — rejection path**

In the same session (or a fresh one): `/plan`, ask for a different plan, and when the confirm dialog appears, **reject** it.

Expected:

- No file is written under `docs/plans/`.
- Footer still shows "📋 Plan Mode".
- Pi's next turn shows the "User rejected the plan. Revise …" message and stays in plan mode.

- [ ] **Step 8: Manual smoke test — duplicate path suffix**

Start a fresh session, `/plan`, ask for a plan with the same topic as in Step 6, and approve.

Expected: the new file is written to `docs/plans/YYYY-MM-DD-<topic>-2.md` (not overwriting the earlier one).

- [ ] **Step 9: Manual smoke test — invalid topic**

Modify Pi's session (or instruct it directly) to call `exit_plan_mode` with `topic: "Invalid Topic"` or similar non-kebab-case value.

Expected: tool returns the "Invalid topic …" error. Pi retries with a valid topic.

(If you can't easily force this path through normal prompting, it's OK to skip — the code path is small and the regex is visible in the file.)

Stop `npm run dev`.

Clean up test plan files before committing:

```bash
rm -f docs/plans/2026-04-13-hello-world*.md
```

- [ ] **Step 10: Commit**

```bash
git add resources/pi-extensions/fleet-plan-mode.ts
git commit -m "$(cat <<'EOF'
feat(pi): add exit_plan_mode tool with approval and file write

When the LLM calls exit_plan_mode(plan, topic), validate the topic,
compute a unique path under docs/plans/YYYY-MM-DD-<topic>.md, show
a confirm dialog with a preview, and — on approve — write the file
and exit plan mode. Rejected plans leave the mode on and are not
written to disk.
EOF
)"
```

---

## Task 5: Changelog entry + end-to-end verification

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Open `CHANGELOG.md`. Under `## [Unreleased]` → `### Added` (currently lines 5-7), append a new bullet after the existing Pi Agent tab bullet:

```markdown
- Pi plan mode: `/plan` in the Pi tab enters a read-only investigation mode with an injected protocol (understand, explore, check scope, ask when ambiguous, consider alternatives, follow existing patterns, YAGNI). Write/exec tools (`write`, `edit`, `bash`, `fleet_run`) are blocked. Pi calls `exit_plan_mode` with a markdown plan; after the user approves, the plan is written to `docs/plans/YYYY-MM-DD-<topic>.md` and plan mode exits.
```

- [ ] **Step 2: Run the full spec test checklist**

Per the spec's "Testing" section, run through all seven scenarios in one `npm run dev` session. Each should behave as described in the spec:

1. `/plan` → footer shows "📋 Plan Mode", notify appears.
2. Ask Pi to add a logging helper → reads files but refuses to write (block reason in tool result).
3. Pi calls `exit_plan_mode` → confirm dialog with preview appears.
4. Approve → file written to `docs/plans/YYYY-MM-DD-<topic>.md`, footer clears, Pi can now edit.
5. Repeat 1–3 and reject → no file, Pi stays in plan mode.
6. `/plan` → `/plan cancel` → mode exits, no file.
7. Start a fresh session mid-plan-mode (via `/new`) → new session has `planMode = false`.

Delete any test plan files that ended up in `docs/plans/` during verification.

- [ ] **Step 3: Final typecheck + lint + build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all three pass. (`npm run build` runs typecheck first then electron-vite build. This is the closest equivalent to a green CI run.)

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: add Pi plan mode entry to changelog

Covers /plan command, investigation protocol injection, write/exec
tool blocking, and exit_plan_mode-with-approval flow.
EOF
)"
```

---

## Done

After Task 5, the feature is complete per the spec. The working tree should contain five new commits (one per task) on top of the spec commit.

Open questions during implementation → answer inline and note in the final commit if the decision diverges from the spec; do not leave TODOs in the code.
