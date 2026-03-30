import { describe, it, expect } from 'vitest';
import { formatPermissionSummary } from '../format-permission';
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
  });
});
