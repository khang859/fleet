import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClaudePermissionMode } from '../../../../../shared/claude-sessions';
import { TooltipProvider } from '../ui/tooltip';
import { ModeLabel } from '../ModeLabel';

function render(mode: ClaudePermissionMode | undefined): string {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ModeLabel, { mode }))
  );
}

describe('ModeLabel', () => {
  it('names the mode the session last reported', () => {
    expect(render('plan')).toContain('>plan mode<');
    expect(render('default')).toContain('>manual mode<');
  });

  it('shows nothing before the session reports a mode', () => {
    expect(render(undefined)).toBe('');
  });
});
