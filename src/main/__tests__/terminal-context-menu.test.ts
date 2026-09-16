import { describe, it, expect, vi } from 'vitest';
import { buildTerminalContextMenuTemplate, revealLabel } from '../terminal-context-menu';
import type { TerminalMenuAction } from '../../shared/ipc-api';

function labels(
  args: Partial<Parameters<typeof buildTerminalContextMenuTemplate>[0]> = {}
): string[] {
  const template = buildTerminalContextMenuTemplate({
    hasSelection: false,
    path: null,
    platform: 'darwin',
    onAction: () => {},
    ...args
  });
  return template.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '')));
}

describe('buildTerminalContextMenuTemplate', () => {
  it('is the plain terminal menu when the pointer is not over a path', () => {
    expect(labels()).toEqual(['Copy', 'Paste', '---', 'Select All', 'Clear']);
  });

  it('puts the path items above the terminal items', () => {
    expect(labels({ path: { canOpenInFleet: true } })).toEqual([
      'Open in Fleet',
      'Reveal in Finder',
      'Copy Path',
      '---',
      'Copy',
      'Paste',
      '---',
      'Select All',
      'Clear'
    ]);
  });

  it('offers no editor for something Fleet cannot show in a pane', () => {
    const items = labels({ path: { canOpenInFleet: false } });
    expect(items).not.toContain('Open in Fleet');
    expect(items.slice(0, 3)).toEqual(['Reveal in Finder', 'Copy Path', '---']);
  });

  it('disables Copy without a selection and enables it with one', () => {
    const disabled = buildTerminalContextMenuTemplate({
      hasSelection: false,
      path: null,
      platform: 'linux',
      onAction: () => {}
    });
    const enabled = buildTerminalContextMenuTemplate({
      hasSelection: true,
      path: null,
      platform: 'linux',
      onAction: () => {}
    });
    expect(disabled[0]).toMatchObject({ label: 'Copy', enabled: false });
    expect(enabled[0]).toMatchObject({ label: 'Copy', enabled: true });
  });

  it('reports the clicked item as its action', () => {
    const onAction = vi.fn<(action: TerminalMenuAction) => void>();
    const template = buildTerminalContextMenuTemplate({
      hasSelection: true,
      path: { canOpenInFleet: true },
      platform: 'darwin',
      onAction
    });
    for (const item of template) {
      item.click?.(undefined as any, undefined as any, undefined as any);
    }
    expect(onAction.mock.calls.flat()).toEqual([
      'openInFleet',
      'reveal',
      'copyPath',
      'copy',
      'paste',
      'selectAll',
      'clear'
    ]);
  });
});

describe('revealLabel', () => {
  it('names each platform file manager', () => {
    expect(revealLabel('darwin')).toBe('Reveal in Finder');
    expect(revealLabel('win32')).toBe('Show in File Explorer');
    expect(revealLabel('linux')).toBe('Show in File Manager');
  });
});
