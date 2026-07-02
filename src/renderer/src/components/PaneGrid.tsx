import { useCallback, useMemo, useRef } from 'react';
import type { PaneNode, PaneLeaf, TerminalBackground } from '../../../shared/types';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import type { SlideshowFrame } from '../hooks/use-slideshow';
import { TerminalPane } from './TerminalPane';
import { PaneHeader } from './PaneHeader';
import { PaneStatusGlyph } from './PaneStatusGlyph';
import { ImageViewerPane } from './ImageViewerPane';
import { PdfViewerPane } from './PdfViewerPane';
import { FileEditorPane } from './FileEditorPane';
import { MarkdownPane } from './MarkdownPane';
import { useWorkspaceStore } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { activityRingClass } from '../lib/activity-glyph';
import { createLogger } from '../logger';

const log = createLogger('layout:panes');

// --- Calc-based absolute positioning system ---
// Each dimension is expressed as `calc(pct% + px)` to handle the 6px resize
// handles without knowing the container's pixel size at render time.

type CalcValue = { pct: number; px: number };
type Rect = { top: CalcValue; left: CalcValue; width: CalcValue; height: CalcValue };

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

function calcToPixels(v: CalcValue, containerDim: number): number {
  return containerDim * (v.pct / 100) + v.px;
}

// --- Layout computation ---

type LeafEntry = { id: string; node: PaneLeaf; rect: Rect };
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

function rectStyle(rect: Rect): React.CSSProperties {
  return {
    position: 'absolute',
    top: toCSS(rect.top),
    left: toCSS(rect.left),
    width: toCSS(rect.width),
    height: toCSS(rect.height)
  };
}

// --- Components ---

type PaneFrameProps = {
  paneId: string;
  isActive: boolean;
  /** Non-terminal panes (file/markdown/image/pdf) have no activity tracking and aren't "agents" - they still get the focus/status ring, but not the status glyph. */
  showGlyph?: boolean;
  children: React.ReactNode;
};

/**
 * Wraps a leaf pane so it can subscribe to its own activity state - the
 * border ring reflects state color when unfocused (the focused pane keeps
 * its accent ring instead, so focus and status don't fight for the same
 * outline), and a corner glyph encodes state + process liveness always.
 *
 * The dim is applied to an inner wrapper (not this outer div) so the ring and
 * status glyph stay at full strength even on a dimmed, unfocused pane - an
 * urgent status ring shouldn't recede along with the content behind it.
 */
function PaneFrame({
  paneId,
  isActive,
  showGlyph = true,
  children
}: PaneFrameProps): React.JSX.Element {
  const activityState = useNotificationStore((s) => s.activities.get(paneId)?.state);
  const ringClass = isActive ? 'fleet-accent-ring-pane' : activityRingClass(activityState);

  return (
    <div className={`relative flex flex-col h-full ${ringClass}`}>
      {showGlyph && (
        <PaneStatusGlyph state={activityState} className="absolute top-1 right-1 z-10" />
      )}
      <div
        className={`flex flex-1 min-h-0 flex-col transition-opacity duration-150 ${isActive ? 'opacity-100' : 'opacity-[0.85]'}`}
      >
        {children}
      </div>
    </div>
  );
}

type PaneGridProps = {
  root: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
  serializedPanes?: Map<string, string>;
  fontFamily?: string;
  fontSize?: number;
  terminalTheme?: TerminalThemeId;
  terminalBackground?: TerminalBackground;
  slideshowFrame?: SlideshowFrame;
};

export function PaneGrid({
  root,
  activePaneId,
  onPaneFocus,
  serializedPanes,
  fontFamily,
  fontSize,
  terminalTheme,
  terminalBackground,
  slideshowFrame
}: PaneGridProps): React.JSX.Element {
  const { splitPane, closePane } = useWorkspaceStore();
  const gridRef = useRef<HTMLDivElement>(null);

  // Stable reference — never changes, safe to omit from deps.
  const fullRect = useRef<Rect>({
    top: cv(0, 0),
    left: cv(0, 0),
    width: cv(100, 0),
    height: cv(100, 0)
  });

  const layout = useMemo(() => computeLayout(root, fullRect.current, []), [root]);

  return (
    <div ref={gridRef} className="h-full w-full" style={{ position: 'relative' }}>
      {/* Terminal panes — flat keyed siblings, never unmounted by tree changes */}
      {layout.leaves.map((leaf) => {
        if (leaf.node.paneType === 'file') {
          return (
            <div key={leaf.id} style={rectStyle(leaf.rect)}>
              <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                <FileEditorPane
                  paneId={leaf.id}
                  filePath={leaf.node.filePath ?? ''}
                  pathContext={leaf.node.pathContext}
                />
              </PaneFrame>
            </div>
          );
        }
        if (leaf.node.paneType === 'markdown') {
          return (
            <div key={leaf.id} style={rectStyle(leaf.rect)}>
              <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                <MarkdownPane
                  paneId={leaf.id}
                  filePath={leaf.node.filePath ?? ''}
                  pathContext={leaf.node.pathContext}
                />
              </PaneFrame>
            </div>
          );
        }
        if (leaf.node.paneType === 'image') {
          return (
            <div key={leaf.id} style={rectStyle(leaf.rect)}>
              <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                <ImageViewerPane
                  filePath={leaf.node.filePath ?? ''}
                  pathContext={leaf.node.pathContext}
                />
              </PaneFrame>
            </div>
          );
        }
        if (leaf.node.paneType === 'pdf') {
          return (
            <div key={leaf.id} style={rectStyle(leaf.rect)}>
              <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                <PdfViewerPane
                  filePath={leaf.node.filePath ?? ''}
                  pathContext={leaf.node.pathContext}
                />
              </PaneFrame>
            </div>
          );
        }
        return (
          <div key={leaf.id} style={rectStyle(leaf.rect)}>
            <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId}>
              {root.type === 'split' && (
                <PaneHeader
                  paneId={leaf.id}
                  label={leaf.node.label}
                  labelIsCustom={leaf.node.labelIsCustom}
                />
              )}
              <div className="flex-1 min-h-0">
                <TerminalPane
                  paneId={leaf.id}
                  cwd={leaf.node.cwd}
                  isActive={leaf.id === activePaneId}
                  onFocus={() => onPaneFocus(leaf.id)}
                  serializedContent={serializedPanes?.get(leaf.id) ?? leaf.node.serializedContent}
                  fontFamily={fontFamily}
                  fontSize={fontSize}
                  terminalTheme={terminalTheme}
                  terminalBackground={terminalBackground}
                  slideshowFrame={slideshowFrame}
                  onSplitHorizontal={() => splitPane(leaf.id, 'horizontal')}
                  onSplitVertical={() => splitPane(leaf.id, 'vertical')}
                  onClose={() => closePane(leaf.id)}
                  shellProfileId={leaf.node.shellProfileId}
                  cmd={leaf.node.cmd}
                />
              </div>
            </PaneFrame>
          </div>
        );
      })}

      {/* Resize handles */}
      {layout.handles.map((h) => (
        <AbsoluteResizeHandle
          key={h.key}
          direction={h.direction}
          path={h.path}
          rect={h.rect}
          splitRect={h.splitRect}
          gridRef={gridRef}
        />
      ))}
    </div>
  );
}

// --- Resize handle (absolute positioned) ---

type AbsoluteResizeHandleProps = {
  direction: 'horizontal' | 'vertical';
  path: number[];
  rect: Rect;
  splitRect: Rect;
  gridRef: React.RefObject<HTMLDivElement | null>;
};

function AbsoluteResizeHandle({
  direction,
  path,
  rect,
  splitRect,
  gridRef
}: AbsoluteResizeHandleProps): React.JSX.Element {
  const isH = direction === 'horizontal';
  const resizeSplit = useWorkspaceStore((s) => s.resizeSplit);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const grid = gridRef.current;
      if (!grid) return;

      log.debug('resize start', { splitNodePath: path });

      const gridRect = grid.getBoundingClientRect();

      document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const target = e.currentTarget;
      const inner = target instanceof HTMLElement ? target.querySelector('div') : null;
      if (inner) inner.classList.add('fleet-accent-bg');

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const containerDim = isH ? gridRect.width : gridRect.height;
        const mousePos = isH ? moveEvent.clientX - gridRect.left : moveEvent.clientY - gridRect.top;

        const splitStart = calcToPixels(isH ? splitRect.left : splitRect.top, containerDim);
        const splitSize = calcToPixels(isH ? splitRect.width : splitRect.height, containerDim);

        if (splitSize > 0) {
          const ratio = (mousePos - splitStart) / splitSize;
          resizeSplit(path, ratio);
        }
      };

      const onMouseUp = (): void => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (inner) inner.classList.remove('fleet-accent-bg');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        log.debug('resize complete', { splitNodePath: path });
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [isH, path, splitRect, gridRef, resizeSplit]
  );

  return (
    <div
      onMouseDown={onMouseDown}
      style={{ ...rectStyle(rect), zIndex: 10 }}
      className={`flex items-center justify-center group/handle ${isH ? 'cursor-col-resize' : 'cursor-row-resize'}`}
    >
      <div
        className={`bg-fleet-surface-2 group-hover/handle:bg-fleet-surface-3 transition-colors ${isH ? 'w-px h-full' : 'h-px w-full'}`}
      />
    </div>
  );
}
