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
}
