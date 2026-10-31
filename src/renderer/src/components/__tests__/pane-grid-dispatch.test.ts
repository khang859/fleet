import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, PaneNode } from '../../../../shared/types';
import { paneSlots } from '../../lib/pane-layout';
import type { PaneGridTab } from '../../lib/pane-layout';

// The real TerminalPane is what creates the PTY, so a spy in its place shows
// exactly which leaves would have spawned a shell.
const { terminalPane } = vi.hoisted(() => ({ terminalPane: vi.fn(() => null) }));
vi.mock('../TerminalPane', () => ({ TerminalPane: terminalPane }));

const { PaneGrid } = await import('../PaneGrid');

const ptyCreate = vi.fn();

function render(root: PaneNode): string {
  return renderToStaticMarkup(
    createElement(PaneGrid, {
      tabs: [gridTab('tab-1', root)],
      activePaneId: null,
      onPaneFocus: () => {}
    })
  );
}

function gridTab(id: string, root: PaneNode, visible = true): PaneGridTab {
  return { id, root, visible, background: false, canMovePanes: true };
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

describe('paneSlots', () => {
  const split = (a: PaneLeaf, b: PaneLeaf): PaneNode => ({
    type: 'split',
    direction: 'horizontal',
    ratio: 0.5,
    children: [a, b]
  });
  const a = leaf('terminal', { id: 'a' });
  const b = leaf('terminal', { id: 'b' });
  const c = leaf('terminal', { id: 'c' });
  const ids = (tabs: PaneGridTab[]): string[] => paneSlots(tabs).map((s) => s.leaf.id);

  // React moves a DOM node when a keyed sibling changes position, and moving a
  // live terminal or iframe resets it. Keeping the order fixed is what lets a
  // pane change tabs without being touched.
  it('keeps pane order when a pane moves to another tab', () => {
    const before = [gridTab('t1', split(c, a)), gridTab('t2', b)];
    const after = [gridTab('t1', a), gridTab('t2', b), gridTab('t3', c)];
    expect(ids(after)).toEqual(ids(before));
  });

  it('keeps pane order when tabs are reordered', () => {
    const one = gridTab('t1', a);
    const two = gridTab('t2', split(b, c));
    expect(ids([two, one])).toEqual(ids([one, two]));
  });

  it('gives a moved pane the whole grid', () => {
    const [slot] = paneSlots([gridTab('t1', a)]);
    expect(slot.leaf.rect.width).toEqual({ pct: 100, px: 0 });
  });
});
