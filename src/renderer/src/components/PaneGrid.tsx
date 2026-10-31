import { Suspense, lazy, memo, useCallback, useRef } from 'react';
import type { PaneLeaf, TerminalBackground, FileOpenTarget } from '../../../shared/types';
import type { PathContext } from '../../../shared/shell-profiles';
import type { RemoteFileRef } from '../../../shared/remote-ssh-types';
import type { OpenablePaneType } from '../../../shared/file-open';
import type { TerminalThemeId } from '../../../shared/theme-presets';
import type { SlideshowFrame } from '../hooks/use-slideshow';
import { TerminalPane } from './TerminalPane';
import { MovePaneButton } from './PaneToolbar';
import { PaneStatusGlyph } from './PaneStatusGlyph';
import { RemoteFileGate } from './ssh/RemoteFileGate';
import { useWorkspaceStore, isTerminalLeaf } from '../store/workspace-store';
import { useNotificationStore } from '../store/notification-store';
import { activityRingClass } from '../lib/activity-glyph';
import { calcToPixels, layoutOf, paneSlots, rectStyle } from '../lib/pane-layout';
import type { PaneGridTab, Rect } from '../lib/pane-layout';
import { createLogger } from '../logger';

const log = createLogger('layout:panes');

// Only TerminalPane is imported eagerly. Every other pane type drags in a large
// dependency it alone needs — pdfjs, CodeMirror, highlight.js, shiki — and a
// window that opens on terminals should not pay to parse any of them. These are
// local disk reads inside Electron, so the chunk resolves within a frame or two.
const ImageViewerPane = lazy(async () => ({
  default: (await import('./ImageViewerPane')).ImageViewerPane
}));
const PdfViewerPane = lazy(async () => ({
  default: (await import('./PdfViewerPane')).PdfViewerPane
}));
const MediaViewerPane = lazy(async () => ({
  default: (await import('./MediaViewerPane')).MediaViewerPane
}));
const FileEditorPane = lazy(async () => ({
  default: (await import('./FileEditorPane')).FileEditorPane
}));
const MarkdownPane = lazy(async () => ({
  default: (await import('./MarkdownPane')).MarkdownPane
}));
const SshBrowserPane = lazy(async () => ({
  default: (await import('./ssh/SshBrowserPane')).SshBrowserPane
}));
const AgentPane = lazy(async () => ({
  default: (await import('./agent/AgentPane')).AgentPane
}));

// Panes sit on the themed pane background, so an empty box is the right
// placeholder — anything more would flash in and out within a couple of frames.
const PANE_FALLBACK = <div className="h-full w-full" />;

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

const NO_PANE_FOCUS = (): void => {};

// --- Components ---

type PaneFrameProps = {
  paneId: string;
  isActive: boolean;
  /** Non-terminal panes (file/markdown/image/pdf) have no activity tracking and aren't "agents" - they still get the focus lift and status ring, but not the status glyph. */
  showGlyph?: boolean;
  /**
   * Makes a press anywhere in the pane focus it, before the pane's own handlers
   * (and so before any pane shortcut) run. Terminals leave it unset: they claim
   * focus themselves on focus and click, and a third handler would only repeat it.
   */
  onPaneFocus?: (paneId: string) => void;
  children: React.ReactNode;
};

/**
 * Wraps a leaf pane so it can subscribe to its own activity state - a ring
 * appears in the colour of that state when it wants attention, and a corner
 * glyph encodes state + process liveness always.
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
  onPaneFocus,
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
      onPointerDownCapture={onPaneFocus ? () => onPaneFocus(paneId) : undefined}
    >
      {/* No border. A pane is bounded by the gutter around it, its own rounded
          ground, and its title bar; drawing an edge as well only restated what
          those already said, and against a background image the extra line read
          as an outline pasted over the picture rather than the card's own edge.
          What is left - the focused card's lift, and a status ring when a pane
          actually wants you - is the part that carries information. */}
      <div
        data-pane-active={isActive ? 'true' : 'false'}
        className={`group/pane relative flex flex-col h-full overflow-hidden rounded-lg ${ringClass}`}
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

/**
 * What a leaf gets when Fleet has nothing to render it with: a pane type from
 * an older build, or an SSH browser that lost its host. Deliberately inert -
 * falling back to a terminal here is how a stale layout used to spawn shells.
 */
function UnsupportedPane({ paneType }: { paneType: string }): React.JSX.Element {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-fleet-glass-chrome text-sm px-6 text-center">
      <div className="text-fleet-text-muted">This pane can&apos;t be shown</div>
      <div className="text-fleet-text-subtle font-mono text-xs break-all">{paneType}</div>
    </div>
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
  remote,
  openTarget
}: {
  paneType: OpenablePaneType;
  paneId: string;
  filePath: string;
  pathContext?: PathContext;
  remote?: RemoteFileRef;
  openTarget?: FileOpenTarget;
}): React.JSX.Element {
  switch (paneType) {
    // The image, PDF and media viewers are read-only - they render straight from the
    // cache copy and only need `remote` to name the file the user asked for.
    case 'image':
      return <ImageViewerPane filePath={filePath} pathContext={pathContext} remote={remote} />;
    case 'pdf':
      return <PdfViewerPane filePath={filePath} pathContext={pathContext} remote={remote} />;
    case 'media':
      return <MediaViewerPane filePath={filePath} pathContext={pathContext} remote={remote} />;
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
          openTarget={openTarget}
        />
      );
  }
}

/** What panes read from settings. Passed through untouched. */
type PaneView = {
  fontFamily?: string;
  fontSize?: number;
  scrollbackSize?: number;
  terminalTheme?: TerminalThemeId;
  terminalBackground?: TerminalBackground;
  slideshowFrame?: SlideshowFrame;
};

type PaneContentProps = PaneView & {
  paneId: string;
  node: PaneLeaf;
  isActive: boolean;
  onPaneFocus: (paneId: string) => void;
  /** Unset when this pane has to stay in its tab. */
  onMoveToTab?: () => void;
  serializedContent?: string;
};

/*
 * The memo boundary for a single terminal. `memo` on `TerminalPane` itself
 * would be inert: its split/close/focus handlers can only be built per leaf, so
 * inlining them in the map would hand it four new functions on every grid
 * render. Owning them here makes them stable, which - together with the
 * identity-preserving tree walkers in the workspace store - means splitting or
 * renaming one pane no longer re-renders its siblings.
 */
const TerminalLeaf = memo(function TerminalLeaf({
  paneId,
  node,
  isActive,
  onPaneFocus,
  onMoveToTab,
  serializedContent,
  fontFamily,
  fontSize,
  scrollbackSize,
  terminalTheme,
  terminalBackground,
  slideshowFrame
}: PaneContentProps): React.JSX.Element {
  const splitPane = useWorkspaceStore((s) => s.splitPane);
  const closePane = useWorkspaceStore((s) => s.closePane);

  const handleFocus = useCallback(() => onPaneFocus(paneId), [onPaneFocus, paneId]);
  const handleSplitHorizontal = useCallback(
    () => splitPane(paneId, 'horizontal'),
    [splitPane, paneId]
  );
  const handleSplitVertical = useCallback(() => splitPane(paneId, 'vertical'), [splitPane, paneId]);
  const handleClose = useCallback(() => closePane(paneId), [closePane, paneId]);

  return (
    <TerminalPane
      paneId={paneId}
      cwd={node.cwd}
      isActive={isActive}
      label={node.label}
      labelIsCustom={node.labelIsCustom}
      onFocus={handleFocus}
      serializedContent={serializedContent}
      fontFamily={fontFamily}
      fontSize={fontSize}
      scrollbackSize={scrollbackSize}
      terminalTheme={terminalTheme}
      terminalBackground={terminalBackground}
      slideshowFrame={slideshowFrame}
      onSplitHorizontal={handleSplitHorizontal}
      onSplitVertical={handleSplitVertical}
      onClose={handleClose}
      onMoveToTab={onMoveToTab}
      shellProfileId={node.shellProfileId}
      cmd={node.cmd}
      typeOnStart={node.typeOnStart}
    />
  );
});

function PaneContent({
  paneId,
  node,
  isActive,
  onPaneFocus,
  onMoveToTab,
  serializedContent,
  ...view
}: PaneContentProps): React.JSX.Element {
  switch (node.paneType) {
    // No paneType is the legacy terminal leaf.
    case undefined:
    case 'terminal':
      return (
        <div className="flex-1 min-h-0">
          {/* The title bar is the terminal's own now, so that the pane
              actions can live in it instead of over the output. */}
          <TerminalLeaf
            paneId={paneId}
            node={node}
            isActive={isActive}
            onPaneFocus={onPaneFocus}
            onMoveToTab={onMoveToTab}
            serializedContent={serializedContent}
            {...view}
          />
        </div>
      );
    case 'agent':
      return (
        <AgentPane
          paneId={paneId}
          cwd={node.cwd}
          sessionId={node.agentSessionId}
          terminalBackground={view.terminalBackground}
          slideshowFrame={view.slideshowFrame}
        />
      );
    case 'ssh-browser':
      return node.remoteHost ? (
        <SshBrowserPane paneId={paneId} host={node.remoteHost} initialPath={node.remotePath} />
      ) : (
        <UnsupportedPane paneType={node.paneType} />
      );
    case 'file':
    case 'markdown':
    case 'image':
    case 'pdf':
    case 'media': {
      const viewerType = node.paneType;
      const remote =
        node.remoteHost && node.remotePath
          ? { host: node.remoteHost, path: node.remotePath }
          : null;
      // Remote files are materialised into the local cache first, so every
      // viewer below sees an ordinary local path and needs no SSH awareness.
      return remote ? (
        <RemoteFileGate host={remote.host} remotePath={remote.path}>
          {(fetched) => (
            <ViewerPane
              paneType={viewerType}
              paneId={paneId}
              filePath={fetched.localPath}
              remote={{ ...remote, mtimeMs: fetched.mtimeMs }}
            />
          )}
        </RemoteFileGate>
      ) : (
        <ViewerPane
          paneType={viewerType}
          paneId={paneId}
          filePath={node.filePath ?? ''}
          pathContext={node.pathContext}
          openTarget={node.openTarget}
        />
      );
    }
    default: {
      // A paneType added to the union without a branch above fails to
      // typecheck here. At runtime this is a value from older saved data.
      const unhandled: never = node.paneType;
      return <UnsupportedPane paneType={String(unhandled)} />;
    }
  }
}

type StagedPaneProps = Omit<PaneContentProps, 'onMoveToTab'> & {
  canMove: boolean;
  top: string | number | undefined;
  left: string | number | undefined;
  width: string | number | undefined;
  height: string | number | undefined;
  visible: boolean;
};

/*
 * The memo boundary for one pane. The rect arrives as four strings rather than
 * an object because a split elsewhere in the tab builds new rect objects with
 * the same values, and every pane of every tab renders through this one parent.
 */
const StagedPane = memo(function StagedPane({
  top,
  left,
  width,
  height,
  visible,
  canMove,
  ...content
}: StagedPaneProps): React.JSX.Element {
  const { paneId, node, isActive, onPaneFocus } = content;
  const isTerminal = isTerminalLeaf(node);
  const movePane = useWorkspaceStore((s) => s.movePaneToNewTab);
  const moveToTab = useCallback(() => movePane(paneId), [movePane, paneId]);

  return (
    <div
      className={PANE_GUTTER}
      style={{
        position: 'absolute',
        top,
        left,
        width,
        height,
        display: visible ? undefined : 'none',
        // Keeps the focused card's shadow above its neighbours. DOM order can't
        // be relied on for that: it follows pane ids, not the layout.
        zIndex: isActive ? 1 : undefined
      }}
    >
      {/* No PaneHeader: the non-terminal panes own their chrome, and the
          terminal draws its own title bar with the glyph in it. */}
      <PaneFrame
        paneId={paneId}
        isActive={isActive}
        showGlyph={false}
        onPaneFocus={isTerminal ? undefined : onPaneFocus}
      >
        <Suspense fallback={PANE_FALLBACK}>
          <PaneContent {...content} onMoveToTab={canMove ? moveToTab : undefined} />
        </Suspense>
        {canMove && !isTerminal && <MovePaneButton onClick={moveToTab} />}
      </PaneFrame>
    </div>
  );
});

type PaneGridProps = PaneView & {
  tabs: PaneGridTab[];
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
};

function PaneGridImpl({
  tabs,
  activePaneId,
  onPaneFocus,
  ...view
}: PaneGridProps): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null);
  const shownTab = tabs.find((tab) => tab.visible);

  return (
    <div
      className={`absolute inset-0 ${GRID_INSET}`}
      style={{ display: shownTab ? 'block' : 'none' }}
    >
      <div ref={gridRef} className="h-full w-full" style={{ position: 'relative' }}>
        {/* All panes are flat keyed siblings: a tab only decides where each sits. */}
        {paneSlots(tabs).map(({ tab, leaf }) => {
          const { top, left, width, height } = rectStyle(leaf.rect);
          return (
            <StagedPane
              key={leaf.id}
              paneId={leaf.id}
              node={leaf.node}
              top={top}
              left={left}
              width={width}
              height={height}
              visible={tab.visible}
              isActive={tab.visible && leaf.id === activePaneId}
              canMove={tab.canMovePanes}
              onPaneFocus={tab.background ? NO_PANE_FOCUS : onPaneFocus}
              serializedContent={tab.serializedPanes?.get(leaf.id) ?? leaf.node.serializedContent}
              {...view}
            />
          );
        })}

        {/* Resize handles */}
        {shownTab &&
          layoutOf(shownTab.root).handles.map((h) => (
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

/*
 * Backstop for #541. Every pane of every tab renders from here, so one
 * whole-object workspace update used to re-render every pane in the app.
 * The store guards are the real fix; this stops the next one that slips through.
 *
 * Requires callers to pass a stable `tabs` and `onPaneFocus` - see App.tsx.
 */
export const PaneGrid = memo(PaneGridImpl);

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
