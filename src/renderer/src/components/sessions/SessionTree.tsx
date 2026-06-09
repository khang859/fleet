// src/renderer/src/components/sessions/SessionTree.tsx
import { useMemo } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import type { SessionTree as SessionTreeData, SessionTreeNode } from '../../../../shared/sessions';
import { tooltipAnim } from '../../lib/motion';
import { flattenTree, pathIds, type TreeRow } from './tree-utils';

function connectorPrefix(row: TreeRow): string {
  const bars = row.ancestorBars.map((bar) => (bar ? '│ ' : '  ')).join('');
  if (row.isRoot) return bars;
  return bars + (row.isLast ? '└─' : '├─');
}

function formatTime(ms?: number): string | null {
  if (ms === undefined) return null;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function NodeRow({
  row,
  isActive,
  isSelected,
  onSelect
}: {
  row: TreeRow;
  isActive: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { node } = row;
  const time = formatTime(node.createdAt);
  const dotColor = isActive ? 'text-blue-400' : 'text-fleet-text-subtle';
  const label = node.preview || `(${node.role})`;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          onClick={() => onSelect(node.id)}
          className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs ${
            isSelected ? 'bg-blue-600/20' : 'hover:bg-fleet-surface-2/50'
          }`}
        >
          <span className="whitespace-pre font-mono text-fleet-text-subtle">
            {connectorPrefix(row)}
          </span>
          <span className={`font-mono ${dotColor}`}>●</span>
          <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle">
            {node.role}
          </span>
          <span className="min-w-0 flex-1 truncate text-fleet-text">{label}</span>
          {node.compactedCount ? (
            <span className="flex-shrink-0 rounded bg-amber-500/20 px-1 text-[10px] text-amber-300">
              compacted {node.compactedCount}
            </span>
          ) : null}
          {isActive ? (
            <span className="flex-shrink-0 text-[10px] text-blue-400">◀ active</span>
          ) : null}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={6}
          className={`z-50 max-w-[260px] rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-white shadow-lg ${tooltipAnim}`}
        >
          <NodeMeta node={node} time={time} />
          <Tooltip.Arrow className="fill-neutral-800" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function NodeMeta({
  node,
  time
}: {
  node: SessionTreeNode;
  time: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="capitalize text-neutral-300">{node.role}</span>
      {time ? <span className="text-neutral-400">{time}</span> : null}
      {node.usage ? (
        <span className="font-mono text-neutral-400">
          ↑{node.usage.input} ↓{node.usage.output}
          {node.usage.cacheRead > 0 ? ` ⚡${node.usage.cacheRead}` : ''}
        </span>
      ) : null}
    </div>
  );
}

export function SessionTree({
  tree,
  selectedNodeId,
  onSelect
}: {
  tree: SessionTreeData;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const rows = useMemo(() => flattenTree(tree), [tree]);
  const activeIds = useMemo(() => pathIds(tree, tree.activeId), [tree]);

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <NodeRow
            key={row.node.id}
            row={row}
            isActive={activeIds.has(row.node.id)}
            isSelected={row.node.id === selectedNodeId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </Tooltip.Provider>
  );
}
