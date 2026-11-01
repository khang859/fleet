import { describe, expect, it } from 'vitest';
import { isToolName, toolAllowed, toolNameFor, toolsFor, type PaneKind } from '../tools';

const KINDS: PaneKind[] = ['outside', 'run', 'last'];

function names(kind: PaneKind): string[] {
  return toolsFor(kind).map((tool) => tool.name);
}

describe('toolsFor', () => {
  it('gives an outside pane the workflow tools', () => {
    expect(names('outside')).toEqual([
      'fleet_workflow_list',
      'fleet_workflow_run',
      'fleet_workflow_status',
      'fleet_workflow_guide',
      'fleet_workflow_create'
    ]);
  });

  it('gives a run pane the board and finish', () => {
    expect(names('run')).toEqual([
      'fleet_findings_add',
      'fleet_findings_list',
      'fleet_run_finish',
      'fleet_workflow_list',
      'fleet_workflow_status'
    ]);
  });

  it('adds merge for the last agent', () => {
    expect(names('last')).toEqual([
      'fleet_findings_add',
      'fleet_findings_list',
      'fleet_findings_merge',
      'fleet_run_finish',
      'fleet_workflow_list',
      'fleet_workflow_status'
    ]);
  });

  it('lists a JSON schema and words for every tool', () => {
    for (const tool of KINDS.flatMap(toolsFor)) {
      expect(tool.description).not.toBe('');
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('marks only what a caller must send as required', () => {
    const run = toolsFor('outside').find((tool) => tool.name === 'fleet_workflow_run');

    expect(run?.inputSchema.required).toEqual(['workflow']);
  });
});

describe('toolAllowed', () => {
  it('follows the pane kind', () => {
    expect(toolAllowed('fleet_findings_merge', 'run')).toBe(false);
    expect(toolAllowed('fleet_findings_merge', 'last')).toBe(true);
    expect(toolAllowed('fleet_workflow_run', 'run')).toBe(false);
    expect(toolAllowed('fleet_workflow_run', 'outside')).toBe(true);
  });
});

describe('isToolName', () => {
  it('knows Fleet tools only', () => {
    expect(isToolName('fleet_run_finish')).toBe(true);
    expect(isToolName('fleet_nope')).toBe(false);
    expect(isToolName('toString')).toBe(false);
  });
});

describe('toolNameFor', () => {
  it('keeps the name for pi', () => {
    expect(toolNameFor('pi', 'fleet_run_finish')).toBe('fleet_run_finish');
  });

  it('adds the mod prefix for claude', () => {
    expect(toolNameFor('claude', 'fleet_run_finish')).toBe('mcp__fleet-bridge__fleet_run_finish');
  });
});
