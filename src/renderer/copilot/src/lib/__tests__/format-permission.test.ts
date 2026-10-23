import { describe, it, expect } from 'vitest';
import {
  PLAN_APPROVAL_CHOICES,
  formatPermissionSummary,
  isPlanApproval,
  modeName,
  suggestionLabel
} from '../format-permission';
import type { CopilotToolInfo } from '../../../../../shared/types';

function tool(toolName: string, toolInput: Record<string, unknown>): CopilotToolInfo {
  return { toolName, toolInput };
}

describe('formatPermissionSummary', () => {
  it('extracts command from bash tool', () => {
    const result = formatPermissionSummary(tool('Bash', { command: 'npm run build' }));
    expect(result.label).toBe('bash: npm run build');
    expect(result.detail).toBe('npm run build');
  });

  it('is case-insensitive for tool names', () => {
    const result = formatPermissionSummary(tool('BASH', { command: 'ls' }));
    expect(result.label).toBe('bash: ls');
  });

  it('extracts file_path from edit tool', () => {
    const result = formatPermissionSummary(tool('Edit', { file_path: 'src/main/index.ts' }));
    expect(result.label).toBe('edit: src/main/index.ts');
    expect(result.detail).toBe('src/main/index.ts');
  });

  it('falls back to path when file_path is missing', () => {
    const result = formatPermissionSummary(tool('edit_file', { path: 'README.md' }));
    expect(result.label).toBe('edit: README.md');
  });

  it('extracts file_path from write/create_file', () => {
    const result = formatPermissionSummary(tool('Write', { file_path: '/tmp/out.json' }));
    expect(result.label).toBe('write: /tmp/out.json');
  });

  it('extracts file_path from create_file', () => {
    const result = formatPermissionSummary(tool('create_file', { path: 'new.ts' }));
    expect(result.label).toBe('write: new.ts');
  });

  it('extracts file_path from read tool', () => {
    const result = formatPermissionSummary(tool('Read', { file_path: 'package.json' }));
    expect(result.label).toBe('read: package.json');
  });

  it('extracts pattern from glob tool', () => {
    const result = formatPermissionSummary(tool('Glob', { pattern: '**/*.ts' }));
    expect(result.label).toBe('glob: **/*.ts');
  });

  it('extracts pattern from grep tool', () => {
    const result = formatPermissionSummary(tool('Grep', { pattern: 'TODO' }));
    expect(result.label).toBe('grep: TODO');
  });

  it('extracts query from WebSearch', () => {
    const result = formatPermissionSummary(tool('WebSearch', { query: 'electron IPC' }));
    expect(result.label).toBe('search: electron IPC');
  });

  it('extracts url from WebFetch', () => {
    const result = formatPermissionSummary(tool('WebFetch', { url: 'https://example.com' }));
    expect(result.label).toBe('fetch: https://example.com');
  });

  it('returns just toolName for unknown tools', () => {
    const result = formatPermissionSummary(tool('SomeNewTool', { foo: 'bar' }));
    expect(result.label).toBe('SomeNewTool');
    expect(result.detail).toBe('SomeNewTool');
  });

  it('truncates long values so label stays within 60 chars', () => {
    const longCommand = 'a'.repeat(80);
    const result = formatPermissionSummary(tool('Bash', { command: longCommand }));
    // maxValueLength = 60 - "bash".length - ": ".length = 54
    // truncate(80 a's, 54) => 53 a's + "…" = 54 chars
    // label = "bash: " + 54 chars = 60 chars total
    expect(result.label).toBe(`bash: ${'a'.repeat(53)}…`);
    expect(result.label.length).toBe(60);
    expect(result.detail).toBe(longCommand);
  });

  it('handles missing expected field gracefully', () => {
    const result = formatPermissionSummary(tool('Bash', {}));
    expect(result.label).toBe('Bash');
    expect(result.detail).toBe('Bash');
    expect(result.matched).toBe(false);
  });

  it('marks a known tool as matched and keeps its description', () => {
    const result = formatPermissionSummary(
      tool('Bash', { command: 'touch a.txt', description: 'Create a.txt' })
    );
    expect(result.matched).toBe(true);
    expect(result.description).toBe('Create a.txt');
  });

  it('has no description when the tool gives none', () => {
    expect(formatPermissionSummary(tool('Read', { file_path: 'a.ts' })).description).toBeNull();
  });

  it('summarizes a plan by its text, not the bare tool name', () => {
    const plan = '1. Create `hello.txt`\n2. Verify it\n';
    const result = formatPermissionSummary(
      tool('ExitPlanMode', { plan, planFilePath: '/Users/me/.claude/plans/moon.md' })
    );
    expect(result.matched).toBe(true);
    expect(result.label).toBe(`plan: ${plan}`);
    expect(result.detail).toBe(plan);
  });
});

describe('isPlanApproval', () => {
  it('is true for an ExitPlanMode ask that carries its plan', () => {
    expect(isPlanApproval(tool('ExitPlanMode', { plan: '1. Do it', planFilePath: '/p.md' }))).toBe(
      true
    );
  });

  it('is false for other tools and for a plan ask with no plan text', () => {
    expect(isPlanApproval(tool('Bash', { plan: 'x' }))).toBe(false);
    expect(isPlanApproval(tool('ExitPlanMode', {}))).toBe(false);
  });
});

describe('PLAN_APPROVAL_CHOICES', () => {
  it('offers auto, accept edits and manual, in the order of the terminal dialog', () => {
    expect(PLAN_APPROVAL_CHOICES).toEqual([
      { mode: 'auto', label: 'Allow, and use auto mode' },
      { mode: 'acceptEdits', label: 'Allow, and accept edits' },
      { mode: 'default', label: 'Allow, and approve edits manually' }
    ]);
  });
});

describe('modeName', () => {
  it('names each mode as the terminal status line does', () => {
    expect(modeName('default')).toBe('manual mode');
    expect(modeName('acceptEdits')).toBe('accept edits');
    expect(modeName('plan')).toBe('plan mode');
    expect(modeName('auto')).toBe('auto mode');
    expect(modeName('dontAsk')).toBe("don't ask");
    expect(modeName('bypassPermissions')).toBe('bypass permissions');
  });
});

describe('suggestionLabel', () => {
  it('names the rules to add and where they are kept', () => {
    expect(
      suggestionLabel({
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'WebSearch' }],
        behavior: 'allow',
        destination: 'localSettings'
      })
    ).toBe("Allow, and don't ask again for Bash(npm test:*), WebSearch in this project");
  });

  it('tells a shared project rule and a rule for every project apart', () => {
    const rule = (destination: 'projectSettings' | 'userSettings'): string =>
      suggestionLabel({
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        behavior: 'allow',
        destination
      });
    expect(rule('projectSettings')).toBe(
      "Allow, and don't ask again for Bash(ls:*) in this project (shared)"
    );
    expect(rule('userSettings')).toBe("Allow, and don't ask again for Bash(ls:*) in all projects");
  });

  it('names the folders to allow', () => {
    expect(
      suggestionLabel({ type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' })
    ).toBe("Allow, and don't ask again in /tmp/x this session");
  });

  it('names the mode to switch to and how long it lasts', () => {
    expect(suggestionLabel({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe(
      'Allow, and switch to accept edits this session'
    );
    expect(suggestionLabel({ type: 'setMode', mode: 'plan', destination: 'localSettings' })).toBe(
      'Allow, and switch to plan mode in this project'
    );
    expect(suggestionLabel({ type: 'setMode', mode: 'default', destination: 'session' })).toBe(
      'Allow, and switch to manual mode this session'
    );
  });
});
