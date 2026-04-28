import { describe, expect, it } from 'vitest';

import {
  buildPlanApprovalMessage,
  getPlanModeActiveTools,
  shouldBlockPlanModeTool
} from '../../../resources/pi-extensions/fleet-plan-mode-policy';

describe('fleet plan mode extension helpers', () => {
  it('activates read-only tools and exit_plan_mode while preserving allowed existing tools', () => {
    expect(getPlanModeActiveTools(['read', 'bash', 'fleet_open', 'custom_tool'])).toEqual([
      'read',
      'fleet_open',
      'custom_tool',
      'grep',
      'find',
      'ls',
      'exit_plan_mode'
    ]);
  });

  it('blocks write and execution tools in plan mode as a final policy gate', () => {
    expect(shouldBlockPlanModeTool('write')).toBe(true);
    expect(shouldBlockPlanModeTool('edit')).toBe(true);
    expect(shouldBlockPlanModeTool('bash')).toBe(true);
    expect(shouldBlockPlanModeTool('fleet_run')).toBe(true);
    expect(shouldBlockPlanModeTool('read')).toBe(false);
  });

  it('builds approval text with target path but no plan body', () => {
    const message = buildPlanApprovalMessage('/repo/docs/plans/2026-04-25-demo.md');

    expect(message).toContain('/repo/docs/plans/2026-04-25-demo.md');
    expect(message).toContain('Review it in the Fleet plan modal');
    expect(message).not.toContain('Line 1');
  });
});
