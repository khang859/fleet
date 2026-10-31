import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, PaneNode } from '../../../../shared/types';

// The real TerminalPane is what creates the PTY, so a spy in its place shows
// exactly which leaves would have spawned a shell.
const { terminalPane } = vi.hoisted(() => ({ terminalPane: vi.fn(() => null) }));
vi.mock('../TerminalPane', () => ({ TerminalPane: terminalPane }));

const { PaneGrid } = await import('../PaneGrid');

const ptyCreate = vi.fn();

function render(root: PaneNode): string {
  return renderToStaticMarkup(
    createElement(PaneGrid, { root, activePaneId: null, onPaneFocus: () => {} })
  );
}

function leaf(paneType: unknown, extra: Partial<PaneLeaf> = {}): PaneLeaf {
  return { type: 'leaf', id: 'pane-1', cwd: '/home', paneType, ...extra } as PaneLeaf;
}

describe('PaneGrid leaf dispatch (#469)', () => {
  beforeEach(() => {
    Object.assign(window.fleet, { pty: { create: ptyCreate } });
  });

  it.each([undefined, 'terminal'])('renders a terminal for paneType %s', (paneType) => {
    render(leaf(paneType));
    expect(terminalPane).toHaveBeenCalledTimes(1);
  });

  it('renders an unknown paneType as an unsupported pane, never a terminal', () => {
    const html = render(leaf('pi'));
    expect(html).toContain('This pane can&#x27;t be shown');
    expect(html).toContain('>pi<');
    expect(terminalPane).not.toHaveBeenCalled();
    expect(ptyCreate).not.toHaveBeenCalled();
  });

  it('renders an ssh-browser without a host as unsupported, not a terminal', () => {
    const html = render(leaf('ssh-browser'));
    expect(html).toContain('>ssh-browser<');
    expect(terminalPane).not.toHaveBeenCalled();
    expect(ptyCreate).not.toHaveBeenCalled();
  });

  it('keeps the terminal beside an unknown pane in a split', () => {
    const html = render({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('terminal', { id: 'term' }), leaf('kanban', { id: 'old' })]
    });
    expect(terminalPane).toHaveBeenCalledTimes(1);
    expect(html).toContain('>kanban<');
  });
});
