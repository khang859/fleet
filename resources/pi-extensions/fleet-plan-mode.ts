/**
 * Fleet Plan Mode Extension for Pi Coding Agent
 *
 * Adds a "plan mode" to Pi. While active, Pi follows an investigation
 * protocol injected into the system prompt; the active toolset is
 * swapped to hide write/exec tools via pi.setActiveTools. The LLM
 * produces a markdown plan via the exit_plan_mode tool; the plan is
 * written to docs/plans/YYYY-MM-DD-<topic>.md after the user approves.
 *
 * Also registers pi's built-in grep/find/ls tools, which are not in
 * the default toolset.
 */

import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ExtensionAPI,
  type ExtensionContext
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAN_MODE_STATUS_KEY = 'plan-mode';
const PLAN_MODE_STATUS_LABEL = '📋 Plan Mode';

const PLAN_MODE_ADDENDUM = `Plan Mode Investigation Protocol

You are in plan mode. Only read-only tools are available (write, edit, bash, fleet_run are hidden). Use read/grep/find/ls/fleet_open to investigate. Follow this protocol:

1. Understand the question. Restate the ask in your own words if anything is ambiguous. Identify purpose, constraints, and what "done" looks like.

2. Explore before planning. Read the relevant files yourself — don't guess. Start broad (project structure, related docs, recent commits) then narrow to the specific code paths that will be touched. For bugs, find the root cause before proposing fixes.

3. Check scope. Is this one focused change or multiple independent pieces? If it spans several subsystems, say so and suggest breaking it up before planning.

4. Ask when ambiguous. If purpose, constraints, or success criteria are unclear, ask one question at a time. Prefer multiple-choice. Don't guess and move on.

5. Consider alternatives. Before committing, think through 2–3 options and their trade-offs. Recommend one and say why.

6. Follow existing patterns. Match conventions already in the codebase unless there's a specific reason to deviate. Don't propose unrelated refactoring.

7. YAGNI. Plan only what's asked. No speculative features, flags, or abstractions.

When you have enough that another engineer could execute without asking questions, call exit_plan_mode.`;

const BLOCKED_IN_PLAN = new Set<string>(['write', 'edit', 'bash', 'fleet_run']);

const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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

let planMode = false;
let savedActiveTools: string[] | null = null;

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  pi.registerTool(createGrepToolDefinition(cwd));
  pi.registerTool(createFindToolDefinition(cwd));
  pi.registerTool(createLsToolDefinition(cwd));

  function enterPlanMode(ctx: ExtensionContext): void {
    savedActiveTools = pi.getActiveTools();
    const next = savedActiveTools.filter((t) => !BLOCKED_IN_PLAN.has(t));
    pi.setActiveTools(next);
    planMode = true;
    ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, PLAN_MODE_STATUS_LABEL);
  }

  function leavePlanMode(ctx: ExtensionContext): void {
    if (savedActiveTools) {
      pi.setActiveTools(savedActiveTools);
      savedActiveTools = null;
    }
    planMode = false;
    ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, undefined);
  }

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
        leavePlanMode(ctx);
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

      enterPlanMode(ctx);
      ctx.ui.notify('Plan mode on — read-only until you approve the plan.', 'info');
    }
  });

  pi.on('session_start', async (_event, _ctx) => {
    planMode = false;
    savedActiveTools = null;
  });

  pi.on('before_agent_start', async (event, _ctx) => {
    if (!planMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_ADDENDUM}`
    };
  });

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
      const approved = await ctx.ui.confirm('Approve plan?', `Write to ${planPath}?`);

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

      leavePlanMode(ctx);

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
}
