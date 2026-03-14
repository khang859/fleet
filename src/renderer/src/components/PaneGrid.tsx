import type { PaneNode } from '../../../shared/types';
import { TerminalPane } from './TerminalPane';

type PaneGridProps = {
  root: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
  serializedPanes?: Map<string, string>;
};

export function PaneGrid({ root, activePaneId, onPaneFocus, serializedPanes }: PaneGridProps) {
  return (
    <div className="h-full w-full">
      <PaneNodeRenderer
        node={root}
        activePaneId={activePaneId}
        onPaneFocus={onPaneFocus}
        serializedPanes={serializedPanes}
      />
    </div>
  );
}

type PaneNodeRendererProps = {
  node: PaneNode;
  activePaneId: string | null;
  onPaneFocus: (paneId: string) => void;
  serializedPanes?: Map<string, string>;
};

function PaneNodeRenderer({ node, activePaneId, onPaneFocus, serializedPanes }: PaneNodeRendererProps) {
  if (node.type === 'leaf') {
    return (
      <TerminalPane
        paneId={node.id}
        cwd={node.cwd}
        isActive={node.id === activePaneId}
        onFocus={() => onPaneFocus(node.id)}
        serializedContent={serializedPanes?.get(node.id)}
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
          serializedPanes={serializedPanes}
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
          serializedPanes={serializedPanes}
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

  // Outer div: generous 6px hit area for easy grabbing (Baymard: 76% of sites fail at unified hit areas)
  // Inner div: thin 1px visual divider
  return (
    <div
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
