# Copilot Permission Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show tool name + key parameter inline in the copilot session listing view so users can make informed allow/deny decisions without opening the detail view.

**Architecture:** A pure utility function maps `CopilotToolInfo` (toolName + toolInput) to a human-readable summary string. SessionList.tsx calls this function instead of displaying the raw tool name. No backend, IPC, or type changes.

**Tech Stack:** TypeScript, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-30-copilot-permission-details-design.md`

---

### Task 1: Create `formatPermissionSummary` with tests

**Files:**
- Create: `src/renderer/copilot/src/lib/__tests__/format-permission.test.ts`
- Create: `src/renderer/copilot/src/lib/format-permission.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/copilot/src/lib/__tests__/format-permission.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/copilot/src/lib/__tests__/format-permission.test.ts`
Expected: FAIL — module `../format-permission` does not exist.

- [ ] **Step 3: Implement `formatPermissionSummary`**

Create `src/renderer/copilot/src/lib/format-permission.ts`:

```ts
import type { CopilotToolInfo } from '../../../../shared/types';

type PermissionSummary = { label: string; detail: string };

const MAX_DETAIL_LENGTH = 60;

type ToolMapping = {
  /** Case-insensitive tool name patterns */
  names: string[];
  /** Display prefix shown before the extracted value */
  prefix: string;
  /** Fields to try in order from toolInput */
  fields: string[];
};

const TOOL_MAPPINGS: ToolMapping[] = [
  { names: ['bash'], prefix: 'bash', fields: ['command'] },
  { names: ['edit', 'edit_file'], prefix: 'edit', fields: ['file_path', 'path'] },
  { names: ['write', 'create_file'], prefix: 'write', fields: ['file_path', 'path'] },
  { names: ['read', 'read_file'], prefix: 'read', fields: ['file_path', 'path'] },
  { names: ['glob'], prefix: 'glob', fields: ['pattern'] },
  { names: ['grep'], prefix: 'grep', fields: ['pattern'] },
  { names: ['websearch'], prefix: 'search', fields: ['query'] },
  { names: ['webfetch'], prefix: 'fetch', fields: ['url'] },
];

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

export function formatPermissionSummary(tool: CopilotToolInfo): PermissionSummary {
  const nameLower = tool.toolName.toLowerCase();
  const mapping = TOOL_MAPPINGS.find((m) => m.names.includes(nameLower));

  if (!mapping) {
    return { label: tool.toolName, detail: tool.toolName };
  }

  const rawValue = mapping.fields
    .map((f) => tool.toolInput[f])
    .find((v): v is string => typeof v === 'string');

  if (!rawValue) {
    return { label: tool.toolName, detail: tool.toolName };
  }

  const prefix = mapping.prefix;
  const maxValueLength = MAX_DETAIL_LENGTH - prefix.length - 2; // 2 for ": "
  const label = `${prefix}: ${truncate(rawValue, maxValueLength)}`;

  return { label, detail: rawValue };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/copilot/src/lib/__tests__/format-permission.test.ts`
Expected: All 15 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/lib/format-permission.ts src/renderer/copilot/src/lib/__tests__/format-permission.test.ts
git commit -m "feat(copilot): add formatPermissionSummary utility with tests"
```

---

### Task 2: Wire `formatPermissionSummary` into `SessionList.tsx`

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionList.tsx:1-8,166-180`

- [ ] **Step 1: Add the import**

At the top of `SessionList.tsx`, after the existing imports (line 8), add:

```ts
import { formatPermissionSummary } from '../lib/format-permission';
```

- [ ] **Step 2: Replace permission row text and tooltip**

Replace the current permission display block (lines 173-180):

```tsx
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-amber-400 truncate flex-1">
                            {perm.tool.toolName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{perm.tool.toolName}</TooltipContent>
                      </Tooltip>
```

With:

```tsx
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-amber-400 truncate flex-1">
                            {formatPermissionSummary(perm.tool).label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{formatPermissionSummary(perm.tool).detail}</TooltipContent>
                      </Tooltip>
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: All tests pass, including the new `format-permission.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/SessionList.tsx
git commit -m "feat(copilot): show permission details inline in session list

Addresses #181 — displays tool name + key parameter (command,
file path, pattern, etc.) in the listing view so users can make
informed allow/deny decisions without opening the detail view."
```
