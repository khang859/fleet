import { useCallback, useRef } from 'react';
import type { PaneNode } from '../../../shared/types';
import { TerminalPane } from './TerminalPane';
import { ImageViewerPane } from './ImageViewerPane';
import { FileEditorPane } from './FileEditorPane';
import { useWorkspaceStore } from '../store/workspace-store';

type PaneActions = {
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  closePane: (paneId: string) => void;
};

type PaneGridProps = {
  root: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
  serializedPanes?: Map<string, string>;
  fontFamily?: string;
  fontSize?: number;
};

export function PaneGrid({ root, activePaneId, onPaneFocus, serializedPanes, fontFamily, fontSize }: PaneGridProps) {
  const { splitPane, closePane } = useWorkspaceStore();

  return (
    <div className="h-full w-full">
      <PaneNodeRenderer
        node={root}
        path={[]}
        activePaneId={activePaneId}
        onPaneFocus={onPaneFocus}
        serializedPanes={serializedPanes}
        fontFamily={fontFamily}
        fontSize={fontSize}
        actions={{ splitPane, closePane }}
      />
    </div>
  );
}

type PaneNodeRendererProps = {
  node: PaneNode;
  path: number[];
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
  serializedPanes?: Map<string, string>;
  fontFamily?: string;
  fontSize?: number;
  actions: PaneActions;
};

function PaneNodeRenderer({ node, path, activePaneId, onPaneFocus, serializedPanes, fontFamily, fontSize, actions }: PaneNodeRendererProps) {
  if (node.type === 'leaf') {
    if (node.paneType === 'file') {
      return (
        <FileEditorPane
          paneId={node.id}
          filePath={node.filePath ?? ''}
        />
      );
    }
    if (node.paneType === 'image') {
      return (
        <ImageViewerPane filePath={node.filePath ?? ''} />
      );
    }
    return (
      <TerminalPane
        paneId={node.id}
        cwd={node.cwd}
        isActive={node.id === activePaneId}
        onFocus={() => onPaneFocus(node.id)}
        serializedContent={serializedPanes?.get(node.id)}
        fontFamily={fontFamily}
        fontSize={fontSize}
        onSplitHorizontal={() => actions.splitPane(node.id, 'horizontal')}
        onSplitVertical={() => actions.splitPane(node.id, 'vertical')}
        onClose={() => actions.closePane(node.id)}
      />
    );
  }

  const isHorizontal = node.direction === 'horizontal';

  return (
    <div
      className="flex h-full w-full"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div
        style={{
          [isHorizontal ? 'width' : 'height']: `${node.ratio * 100}%`,
          [isHorizontal ? 'height' : 'width']: '100%',
        }}
      >
        <PaneNodeRenderer
          node={node.children[0]}
          path={[...path, 0]}
          activePaneId={activePaneId}
          onPaneFocus={onPaneFocus}
          serializedPanes={serializedPanes}
          fontFamily={fontFamily}
          fontSize={fontSize}
          actions={actions}
        />
      </div>

      <ResizeHandle direction={node.direction} path={path} />

      <div
        style={{
          [isHorizontal ? 'width' : 'height']: `${(1 - node.ratio) * 100}%`,
          [isHorizontal ? 'height' : 'width']: '100%',
        }}
      >
        <PaneNodeRenderer
          node={node.children[1]}
          path={[...path, 1]}
          activePaneId={activePaneId}
          onPaneFocus={onPaneFocus}
          serializedPanes={serializedPanes}
          fontFamily={fontFamily}
          fontSize={fontSize}
          actions={actions}
        />
      </div>
    </div>
  );
}

type ResizeHandleProps = {
  direction: 'horizontal' | 'vertical';
  path: number[];
};

function ResizeHandle({ direction, path }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';
  const handleRef = useRef<HTMLDivElement>(null);
  const resizeSplit = useWorkspaceStore((s) => s.resizeSplit);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = handleRef.current?.parentElement;
      if (!container) return;

      const rect = container.getBoundingClientRect();

      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const innerDiv = handleRef.current?.querySelector('div');
      if (innerDiv) innerDiv.classList.add('bg-blue-500');

      const onMouseMove = (moveEvent: MouseEvent) => {
        const ratio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
        resizeSplit(path, ratio);
      };

      const onMouseUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (innerDiv) innerDiv.classList.remove('bg-blue-500');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [isHorizontal, path, resizeSplit],
  );

  return (
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      className={`
        flex-shrink-0 flex items-center justify-center group/handle
        ${isHorizontal ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'}
      `}
    >
      <div
        className={`
          bg-neutral-800 group-hover/handle:bg-neutral-500 transition-colors
          ${isHorizontal ? 'w-px h-full' : 'h-px w-full'}
        `}
      />
    </div>
  );
}
