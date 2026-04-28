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

export function buildPlanApprovalMessage(planPath: string): string {
  return `Plan written to:\n${planPath}\n\nReview it in the Fleet plan modal, then approve when ready.`;
}
