/**
 * Fleet Plan Mode Extension for Pi Coding Agent
 *
 * Adds a "plan mode" to Pi. While active, Pi follows an investigation
 * protocol injected into the system prompt; the active toolset is
 * swapped to hide write/exec tools via pi.setActiveTools, with a
 * tool_call blocker as a final policy gate. The LLM
 * produces a markdown plan via the exit_plan_mode tool; the plan is
 * written to docs/plans/YYYY-MM-DD-<topic>.md and opened in Fleet's plan modal.
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
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPlanApprovalMessage,
  getPlanModeActiveTools,
  shouldBlockPlanModeTool
} from './fleet-plan-mode-policy.ts';

type FleetBridgeClient = {
  send: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  onEvent: (handler: (type: string, payload: Record<string, unknown>) => void) => void;
  isConnected: () => boolean;
};

declare global {
  var __fleetBridge: FleetBridgeClient | null; // eslint-disable-line no-var
}

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

When you have enough that another engineer could execute without asking questions, call exit_plan_mode. The plan will be written to a markdown file and opened in Fleet for review; do not include the full plan in a normal assistant message.`;

const PLAN_MODE_BLOCK_REASON =
  'Plan mode is active — this tool is disabled. Use read-only tools to investigate, then call exit_plan_mode with your plan.';

const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

type PlanReviewAction = 'approve' | 'reject' | 'continue';

type PlanReviewResponse = {
  action: PlanReviewAction;
  feedback?: string;
};

type PendingPlanResponse = {
  resolve: (response: PlanReviewResponse) => void;
};

const pendingPlanResponses = new Map<string, PendingPlanResponse>();

function isPlanReviewAction(value: unknown): value is PlanReviewAction {
  return value === 'approve' || value === 'reject' || value === 'continue';
}

function createPlanResponseWaiter(requestId: string, signal: AbortSignal | undefined) {
  let abortHandler: (() => void) | undefined;
  let cleanup = () => {
    pendingPlanResponses.delete(requestId);
  };

  const promise = new Promise<PlanReviewResponse>((resolve) => {
    cleanup = () => {
      pendingPlanResponses.delete(requestId);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
    };
    const finish = (response: PlanReviewResponse) => {
      cleanup();
      resolve(response);
    };
    abortHandler = () => finish({ action: 'continue' });

    pendingPlanResponses.set(requestId, { resolve: finish });
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener('abort', abortHandler, { once: true });
  });

  return { promise, cancel: cleanup };
}

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

  globalThis.__fleetBridge?.onEvent((type, payload) => {
    if (type !== 'pi.plan_response') return;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const action = payload.action;
    if (!requestId || !isPlanReviewAction(action)) return;

    pendingPlanResponses.get(requestId)?.resolve({
      action,
      feedback: typeof payload.feedback === 'string' ? payload.feedback : undefined
    });
  });

  function enterPlanMode(ctx: ExtensionContext): void {
    const activeTools = pi.getActiveTools();
    savedActiveTools = activeTools;
    pi.setActiveTools(getPlanModeActiveTools(activeTools));
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

  pi.on('session_start', async (_event, ctx) => {
    if (planMode || savedActiveTools) leavePlanMode(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    for (const pending of pendingPlanResponses.values()) {
      pending.resolve({ action: 'continue' });
    }
    pendingPlanResponses.clear();
    if (planMode || savedActiveTools) leavePlanMode(ctx);
  });

  pi.on('before_agent_start', async (event, _ctx) => {
    if (!planMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_ADDENDUM}`
    };
  });

  pi.on('tool_call', async (event, _ctx) => {
    if (!planMode) return;
    if (!shouldBlockPlanModeTool(event.toolName)) return;
    return { block: true, reason: PLAN_MODE_BLOCK_REASON };
  });

  pi.registerTool({
    name: 'exit_plan_mode',
    label: 'Exit Plan Mode',
    description:
      'Call this when you have a complete plan ready for the user. Writes the plan to docs/plans/YYYY-MM-DD-<topic>.md, opens it in Fleet for review, then exits plan mode after approval so you can begin executing. Pass the plan as markdown in `plan` and a short kebab-case topic in `topic`.',
    parameters: ExitPlanModeParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      const dir = join(ctx.cwd, 'docs', 'plans');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(planPath, params.plan, 'utf-8');

      let review: PlanReviewResponse | null = null;
      const bridge = globalThis.__fleetBridge;
      if (bridge?.isConnected()) {
        const requestId = randomUUID();
        const responseWaiter = createPlanResponseWaiter(requestId, signal);
        try {
          await bridge.send('pi.plan_open', { path: planPath, requestId });
          review = await responseWaiter.promise;
        } catch (err) {
          responseWaiter.cancel();
          ctx.ui.notify(
            `Plan written, but Fleet could not open it: ${err instanceof Error ? err.message : String(err)}`,
            'warning'
          );
        }
      } else {
        ctx.ui.notify('Plan written, but Fleet bridge is not connected.', 'warning');
      }

      if (!review) {
        const approved = await ctx.ui.confirm('Approve plan?', buildPlanApprovalMessage(planPath));
        review = { action: approved ? 'approve' : 'reject' };
      }

      if (review.action !== 'approve') {
        const feedback = review.feedback?.trim();
        const actionText =
          review.action === 'reject' ? 'rejected the plan' : 'requested more planning';
        return {
          content: [
            {
              type: 'text' as const,
              text: `User ${actionText} for ${planPath}.${feedback ? ` Feedback: ${feedback}` : ''} Revise based on their feedback and call exit_plan_mode again when ready.`
            }
          ],
          details: undefined
        };
      }

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
