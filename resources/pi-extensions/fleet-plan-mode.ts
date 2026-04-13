/**
 * Fleet Plan Mode Extension for Pi Coding Agent
 *
 * Adds a "plan mode" to Pi. While active, Pi follows an investigation
 * protocol injected into the system prompt, write/exec tools are blocked,
 * and the LLM produces a markdown plan via the `exit_plan_mode` tool.
 * The plan is written to docs/plans/YYYY-MM-DD-<topic>.md after the user
 * approves it.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PLAN_MODE_STATUS_KEY = "plan-mode";
const PLAN_MODE_STATUS_LABEL = "📋 Plan Mode";

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

let planMode = false;

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("plan", {
    description:
      "Enter plan mode (read-only investigation, ends with an approved markdown plan). Use `/plan cancel` to exit without a plan.",
    handler: async (args, ctx) => {
      const subcommand = (args ?? "").trim();

      if (subcommand === "cancel") {
        if (!planMode) {
          ctx.ui.notify("Plan mode is not active.", "info");
          return;
        }
        planMode = false;
        ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, undefined);
        ctx.ui.notify("Plan mode cancelled. No plan was written.", "info");
        return;
      }

      if (subcommand.length > 0) {
        ctx.ui.notify(
          `Unknown subcommand '${subcommand}'. Use '/plan' or '/plan cancel'.`,
          "warning",
        );
        return;
      }

      if (planMode) {
        ctx.ui.notify("Plan mode is already on.", "info");
        return;
      }

      planMode = true;
      ctx.ui.setStatus(PLAN_MODE_STATUS_KEY, PLAN_MODE_STATUS_LABEL);
      ctx.ui.notify(
        "Plan mode on — read-only until you approve the plan.",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, _ctx) => {
    planMode = false;
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!planMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_ADDENDUM}`,
    };
  });
}
