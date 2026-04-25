const PLAN_PREVIEW_LINES = 60;

const BLOCKED_IN_PLAN = new Set<string>(['write', 'edit', 'bash', 'fleet_run']);
const REQUIRED_PLAN_MODE_TOOLS = ['read', 'grep', 'find', 'ls', 'fleet_open', 'exit_plan_mode'];

export function shouldBlockPlanModeTool(toolName: string): boolean {
  return BLOCKED_IN_PLAN.has(toolName);
}

export function getPlanModeActiveTools(currentActiveTools: string[]): string[] {
  const next = currentActiveTools.filter((toolName) => !shouldBlockPlanModeTool(toolName));
  for (const toolName of REQUIRED_PLAN_MODE_TOOLS) {
    if (!next.includes(toolName)) next.push(toolName);
  }
  return next;
}

function previewPlan(plan: string): string {
  const lines = plan.split('\n');
  if (lines.length <= PLAN_PREVIEW_LINES) return plan;
  const remaining = lines.length - PLAN_PREVIEW_LINES;
  return `${lines.slice(0, PLAN_PREVIEW_LINES).join('\n')}\n\n(${remaining} more lines)`;
}

export function buildPlanApprovalMessage(planPath: string, plan: string): string {
  return `Path: ${planPath}\n\n---\n\n${previewPlan(plan)}`;
}
