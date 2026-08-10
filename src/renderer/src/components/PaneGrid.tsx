import { useCallback, useMemo, useRef } from 'react';
import type { PaneNode, PaneLeaf, TerminalBackground } from '../../../shared/types';
import type { PathContext } from '../../../shared/shell-profiles';
import type { RemoteFileRef } from '../../../shared/remote-ssh-types';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import type { SlideshowFrame } from '../hooks/use-slideshow';
import { TerminalPane } from './TerminalPane';
import { PaneStatusGlyph } from './PaneStatusGlyph';
import { ImageViewerPane } from './ImageViewerPane';
import { PdfViewerPane } from './PdfViewerPane';
import { FileEditorPane } from './FileEditorPane';
import { MarkdownPane } from './MarkdownPane';
import { SshBrowserPane } from './ssh/SshBrowserPane';
import { AgentPane } from './agent/AgentPane';
import { RemoteFileGate } from './ssh/RemoteFileGate';
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

// The canvas gutter is 8px, and two things already contribute to it between a
// pair of panes: each leaf's own padding, twice, plus the HANDLE_PX seam the
// split maths carves out for the resize handle. So the leaf padding is what is
// left over - (8 - 6) / 2 = 1 - and the grid's outer inset is the rest, 7, to
// bring the window edge to the same 8.
//
// The outer inset cannot live on the grid element itself: leaves are absolutely
// positioned, and an absolute child resolves against its ancestor's padding
// box, so padding there moves nothing. It goes on a wrapper instead.
const PANE_GUTTER = 'p-px';
const GRID_INSET = 'p-[7px]';

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
 * Wraps a leaf pane so it can subscribe to its own activity state - the border
 * ring reflects state color, and a corner glyph encodes state + process
 * liveness always.
 *
 * Focus is carried by elevation and by the pane's own title bar, never by a
 * colour. The focused card keeps its shadow and its title bar lights up; every
 * other card flattens onto the canvas and its title bar goes grey. That is the
 * active/inactive window model macOS has used for decades, and it leaves the
 * accent free to keep meaning "something needs you" - the status ring, the
 * activity glyph, the permission prompt. An accent ring here made the colour
 * say two unrelated things, and shouted the less interesting one.
 *
 * `group/pane` + `data-pane-active` is how the title bars downstream find out;
 * see `PaneHeader` and `PathChromeHeader`. It avoids threading a prop through
 * five pane types that otherwise have no interest in focus.
 */
function PaneFrame({
  paneId,
  isActive,
  showGlyph = true,
  children
}: PaneFrameProps): React.JSX.Element {
  const activityState = useNotificationStore((s) => s.activities.get(paneId)?.state);
  const ringClass = activityRingClass(activityState);

  return (
    // Two elements because the drop shadow and the state ring are both
    // box-shadow, and the ring classes set it raw, so anything sharing an
    // element with them loses. The outer div owns the lift, the inner the ring.
    <div
      className={`h-full rounded-lg transition-shadow duration-150 ${
        isActive ? 'shadow-lg shadow-black/30' : ''
      }`}
    >
      {/* The hairline is not decoration: a glass terminal over a busy picture
          has no ground of its own to end against, so without an edge an
          inactive card stops reading as a card at all. It firms up on the
          focused pane, which is the quietest half of the focus cue. */}
      <div
        data-pane-active={isActive ? 'true' : 'false'}
        className={`group/pane relative flex flex-col h-full overflow-hidden rounded-lg border transition-colors ${
          isActive ? 'border-fleet-border-strong' : 'border-fleet-border'
        } ${ringClass}`}
      >
        {showGlyph && (
          <PaneStatusGlyph state={activityState} className="absolute top-1 right-1 z-10" />
        )}
        {/* Inactive panes used to dim the whole subtree, which dimmed terminal
            text along with the chrome. The card's ring and its ground colour
            carry that signal now, so the text stays at full contrast. */}
        <div className="flex flex-1 min-h-0 flex-col">{children}</div>
      </div>
    </div>
  );
}

type ViewerPaneType = 'file' | 'markdown' | 'image' | 'pdf';

function isViewerPaneType(paneType: PaneLeaf['paneType']): paneType is ViewerPaneType {
  return (
    paneType === 'file' || paneType === 'markdown' || paneType === 'image' || paneType === 'pdf'
  );
}

/**
 * Dispatches to the right viewer for a file-backed pane. `filePath` is always a
 * path the local `fs` can reach - for remote panes that is the cache copy, and
 * `remote` carries the origin so writes go back over SSH instead of into it.
 */
function ViewerPane({
  paneType,
  paneId,
  filePath,
  pathContext,
  remote
}: {
  paneType: ViewerPaneType;
  paneId: string;
  filePath: string;
  pathContext?: PathContext;
  remote?: RemoteFileRef;
}): React.JSX.Element {
  switch (paneType) {
    // The image and PDF viewers are read-only - they render straight from the
    // cache copy and only need `remote` to name the file the user asked for.
    case 'image':
      return <ImageViewerPane filePath={filePath} pathContext={pathContext} remote={remote} />;
    case 'pdf':
      return <PdfViewerPane filePath={filePath} pathContext={pathContext} remote={remote} />;
    case 'markdown':
      return (
        <MarkdownPane
          paneId={paneId}
          filePath={filePath}
          pathContext={pathContext}
          remote={remote}
        />
      );
    case 'file':
      return (
        <FileEditorPane
          paneId={paneId}
          filePath={filePath}
          pathContext={pathContext}
          remote={remote}
        />
      );
  }
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
    <div className={`h-full w-full ${GRID_INSET}`}>
      <div ref={gridRef} className="h-full w-full" style={{ position: 'relative' }}>
        {/* Terminal panes — flat keyed siblings, never unmounted by tree changes */}
        {layout.leaves.map((leaf) => {
          if (leaf.node.paneType === 'agent') {
            return (
              <div key={leaf.id} className={PANE_GUTTER} style={rectStyle(leaf.rect)}>
                {/* No PaneHeader: like the other non-terminal panes, the agent
                  pane owns its own chrome and has no live cwd to show. */}
                <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                  <AgentPane
                    paneId={leaf.id}
                    cwd={leaf.node.cwd}
                    sessionId={leaf.node.agentSessionId}
                    terminalBackground={terminalBackground}
                    slideshowFrame={slideshowFrame}
                  />
                </PaneFrame>
              </div>
            );
          }
          if (leaf.node.paneType === 'ssh-browser' && leaf.node.remoteHost) {
            const host = leaf.node.remoteHost;
            return (
              <div key={leaf.id} className={PANE_GUTTER} style={rectStyle(leaf.rect)}>
                <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                  <SshBrowserPane paneId={leaf.id} host={host} initialPath={leaf.node.remotePath} />
                </PaneFrame>
              </div>
            );
          }
          const viewerType = leaf.node.paneType;
          if (isViewerPaneType(viewerType)) {
            const node = leaf.node;
            const remote =
              node.remoteHost && node.remotePath
                ? { host: node.remoteHost, path: node.remotePath }
                : null;
            // Remote files are materialised into the local cache first, so every
            // viewer below sees an ordinary local path and needs no SSH awareness.
            return (
              <div key={leaf.id} className={PANE_GUTTER} style={rectStyle(leaf.rect)}>
                <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                  {remote ? (
                    <RemoteFileGate host={remote.host} remotePath={remote.path}>
                      {(fetched) => (
                        <ViewerPane
                          paneType={viewerType}
                          paneId={leaf.id}
                          filePath={fetched.localPath}
                          remote={{ ...remote, mtimeMs: fetched.mtimeMs }}
                        />
                      )}
                    </RemoteFileGate>
                  ) : (
                    <ViewerPane
                      paneType={viewerType}
                      paneId={leaf.id}
                      filePath={node.filePath ?? ''}
                      pathContext={node.pathContext}
                    />
                  )}
                </PaneFrame>
              </div>
            );
          }
          return (
            <div key={leaf.id} className={PANE_GUTTER} style={rectStyle(leaf.rect)}>
              {/* The glyph moved into the title bar, which the terminal draws
                itself - leaving it here too would put it under the actions. */}
              <PaneFrame paneId={leaf.id} isActive={leaf.id === activePaneId} showGlyph={false}>
                <div className="flex-1 min-h-0">
                  {/* The title bar is the terminal's own now, so that the pane
                    actions can live in it instead of over the output. */}
                  <TerminalPane
                    paneId={leaf.id}
                    cwd={leaf.node.cwd}
                    isActive={leaf.id === activePaneId}
                    label={leaf.node.label}
                    labelIsCustom={leaf.node.labelIsCustom}
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
      if (inner) inner.classList.add('fleet-accent-bg', 'opacity-100');

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
        if (inner) inner.classList.remove('fleet-accent-bg', 'opacity-100');
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
      {/* The gutter between two cards already separates them, so the handle
          shows nothing until it is worth grabbing - then a short pill, not a
          full-length rule, because the thing being offered is a grip. */}
      <div
        className={`rounded-full bg-fleet-border-strong opacity-0 group-hover/handle:opacity-100 transition-opacity ${
          isH ? 'w-[3px] h-8' : 'h-[3px] w-8'
        }`}
      />
    </div>
  );
}
