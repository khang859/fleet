import type { PaneLeaf, PaneNode } from '../../../shared/types';

// --- Calc-based absolute positioning system ---
// Each dimension is expressed as `calc(pct% + px)` to handle the 6px resize
// handles without knowing the container's pixel size at render time.

type CalcValue = { pct: number; px: number };
export type Rect = { top: CalcValue; left: CalcValue; width: CalcValue; height: CalcValue };

const HANDLE_PX = 6;
const HALF_HANDLE = HANDLE_PX / 2;

function cv(pct: number, px: number): CalcValue {
  return { pct, px };
}

function toCSS(v: CalcValue): string {
  if (v.px === 0) return `${v.pct}%`;
  if (v.pct === 0) return `${v.px}px`;
  return `calc(${v.pct}% + ${v.px}px)`;
}

function addCV(a: CalcValue, b: CalcValue): CalcValue {
  return { pct: a.pct + b.pct, px: a.px + b.px };
}

function scaleCV(a: CalcValue, f: number): CalcValue {
  return { pct: a.pct * f, px: a.px * f };
}

export function calcToPixels(v: CalcValue, containerDim: number): number {
  return containerDim * (v.pct / 100) + v.px;
}

// --- Layout computation ---

export type LeafEntry = { id: string; node: PaneLeaf; rect: Rect };
type HandleEntry = {
  key: string;
  path: number[];
  direction: 'horizontal' | 'vertical';
  rect: Rect;
  splitRect: Rect;
};
type Layout = { leaves: LeafEntry[]; handles: HandleEntry[] };

function computeLayout(node: PaneNode, rect: Rect, path: number[]): Layout {
  if (node.type === 'leaf') {
    return { leaves: [{ id: node.id, node, rect }], handles: [] };
  }

  const r = node.ratio;
  const isH = node.direction === 'horizontal';

  let leftRect: Rect, handleRect: Rect, rightRect: Rect;

  if (isH) {
    const leftW = addCV(scaleCV(rect.width, r), cv(0, -HALF_HANDLE));
    const hLeft = addCV(rect.left, leftW);
    const rLeft = addCV(hLeft, cv(0, HANDLE_PX));
    const rightW = addCV(scaleCV(rect.width, 1 - r), cv(0, -HALF_HANDLE));

    leftRect = { top: rect.top, left: rect.left, width: leftW, height: rect.height };
    handleRect = { top: rect.top, left: hLeft, width: cv(0, HANDLE_PX), height: rect.height };
    rightRect = { top: rect.top, left: rLeft, width: rightW, height: rect.height };
  } else {
    const topH = addCV(scaleCV(rect.height, r), cv(0, -HALF_HANDLE));
    const hTop = addCV(rect.top, topH);
    const bTop = addCV(hTop, cv(0, HANDLE_PX));
    const botH = addCV(scaleCV(rect.height, 1 - r), cv(0, -HALF_HANDLE));

    leftRect = { top: rect.top, left: rect.left, width: rect.width, height: topH };
    handleRect = { top: hTop, left: rect.left, width: rect.width, height: cv(0, HANDLE_PX) };
    rightRect = { top: bTop, left: rect.left, width: rect.width, height: botH };
  }

  const left = computeLayout(node.children[0], leftRect, [...path, 0]);
  const right = computeLayout(node.children[1], rightRect, [...path, 1]);

  return {
    leaves: [...left.leaves, ...right.leaves],
    handles: [
      ...left.handles,
      ...right.handles,
      {
        key: path.join('-') || 'root',
        path,
        direction: node.direction,
        rect: handleRect,
        splitRect: rect
      }
    ]
  };
}

export function rectStyle(rect: Rect): React.CSSProperties {
  return {
    position: 'absolute',
    top: toCSS(rect.top),
    left: toCSS(rect.left),
    width: toCSS(rect.width),
    height: toCSS(rect.height)
  };
}

const FULL_RECT: Rect = {
  top: cv(0, 0),
  left: cv(0, 0),
  width: cv(100, 0),
  height: cv(100, 0)
};

// Keyed by tree identity: the store's walkers keep a root the same object when
// nothing in it moved, so a layout is only ever computed for a real change.
const layouts = new WeakMap<PaneNode, Layout>();

export function layoutOf(root: PaneNode): Layout {
  const cached = layouts.get(root);
  if (cached) return cached;
  const layout = computeLayout(root, FULL_RECT, []);
  layouts.set(root, layout);
  return layout;
}

export type PaneGridTab = {
  id: string;
  root: PaneNode;
  /** The tab on screen. At most one is, and none while a tool tab is showing. */
  visible: boolean;
  /** Belongs to a workspace that is not the current one, so its panes take no focus. */
  background: boolean;
  /** Whether a pane may leave this tab for one of its own. */
  canMovePanes: boolean;
  serializedPanes?: Map<string, string>;
};

type PaneSlot = { tab: PaneGridTab; leaf: LeafEntry };

/**
 * Every pane of every tab, in pane id order. The order is the point: it does not
 * change when a pane changes tabs, so React has no DOM node to move and a moved
 * pane keeps its terminal, its editor and everything else it has in memory.
 */
export function paneSlots(tabs: PaneGridTab[]): PaneSlot[] {
  return tabs
    .flatMap((tab) => layoutOf(tab.root).leaves.map((leaf) => ({ tab, leaf })))
    .sort((a, b) => a.leaf.id.localeCompare(b.leaf.id));
}
