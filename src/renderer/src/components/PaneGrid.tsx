import type { PaneNode } from '../../../shared/types';
import { TerminalPane } from './TerminalPane';

type PaneGridProps = {
  root: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
};

export function PaneGrid({ root, activePaneId, onPaneFocus }: PaneGridProps) {
  return (
    <div className="h-full w-full">
      <PaneNodeRenderer
        node={root}
        activePaneId={activePaneId}
        onPaneFocus={onPaneFocus}
      />
    </div>
  );
}

type PaneNodeRendererProps = {
  node: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
};

function PaneNodeRenderer({ node, activePaneId, onPaneFocus }: PaneNodeRendererProps) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        paneId={node.id}
        cwd={node.cwd}
        isActive={node.id === activePaneId}
        onFocus={() => onPaneFocus(node.id)}
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
          activePaneId={activePaneId}
          onPaneFocus={onPaneFocus}
        />
      </div>

      <ResizeHandle direction={node.direction} />

      <div
        style={{
          [isHorizontal ? 'width' : 'height']: `${(1 - node.ratio) * 100}%`,
          [isHorizontal ? 'height' : 'width']: '100%',
        }}
      >
        <PaneNodeRenderer
          node={node.children[1]}
          activePaneId={activePaneId}
          onPaneFocus={onPaneFocus}
        />
      </div>
    </div>
  );
}

type ResizeHandleProps = {
  direction: 'horizontal' | 'vertical';
};

function ResizeHandle({ direction }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';

  return (
    <div
      className={`
        flex-shrink-0 bg-neutral-800 hover:bg-neutral-600 transition-colors
        ${isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}
      `}
    />
  );
}
