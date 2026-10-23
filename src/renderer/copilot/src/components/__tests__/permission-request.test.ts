import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CopilotPendingPermission } from '../../../../../shared/types';
import { PermissionRequest } from '../PermissionRequest';

function ask(toolName: string, toolInput: Record<string, unknown>): CopilotPendingPermission {
  return {
    sessionId: 's1',
    toolUseId: 'toolu_1',
    tool: { toolName, toolInput },
    receivedAt: 0
  };
}

function render(permission: CopilotPendingPermission, compact = false): string {
  return renderToStaticMarkup(
    createElement(PermissionRequest, { sessionId: 's1', permission, compact })
  );
}

/** The text of each button, in order. */
const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

const PLAN = [
  '## Hello file',
  '',
  '1. Create `hello.txt` with **hi**',
  '2. Verify it',
  '',
  '[docs](https://example.com)'
].join('\n');

describe('PermissionRequest for a plan', () => {
  const html = render(ask('ExitPlanMode', { plan: PLAN, planFilePath: '/p/moon.md' }));

  it('heads the card "Plan" rather than the tool name, and shows no raw input', () => {
    expect(html).toContain('>Plan<');
    expect(html).not.toContain('ExitPlanMode');
    expect(html).not.toContain('planFilePath');
  });

  it('renders the plan as Markdown, with links drawn as text', () => {
    expect(html).toContain('<ol');
    expect(html).toContain('<code');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).toContain('Hello file');
    expect(html).not.toContain('<a ');
  });

  it('offers the three modes as Allow, a feedback box, and Deny', () => {
    expect(buttons(html)).toEqual([
      'Allow, and use auto mode',
      'Allow, and accept edits',
      'Allow, and approve edits manually',
      'Deny'
    ]);
    expect(html).toMatch(/<textarea[^>]*aria-label="Tell Claude what to change"/);
  });

  it('keeps the same answers in the session list', () => {
    const compact = render(ask('ExitPlanMode', { plan: PLAN, planFilePath: '/p/moon.md' }), true);
    expect(buttons(compact)).toHaveLength(4);
    expect(compact).toContain('max-h-24');
  });
});

describe('PermissionRequest for other tools', () => {
  it('keeps the plain Allow / Deny card', () => {
    const html = render(ask('Bash', { command: 'ls' }));
    expect(html).toContain('>Bash<');
    expect(buttons(html)).toEqual(['Allow', 'Deny']);
    expect(html).not.toContain('<textarea');
  });
});
