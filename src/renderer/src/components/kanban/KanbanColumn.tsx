import { useState } from 'react';
import type { BoardCard, TaskStatus } from '../../../../shared/kanban-types';
import { KanbanCard } from './KanbanCard';
import { DRAG_TARGETS } from './kanban-utils';

type Props = {
  status: TaskStatus;
  label: string;
  cards: BoardCard[];
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropCard: (status: TaskStatus) => void;
};

export function KanbanColumn({
  status,
  label,
  cards,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropCard
}: Props): React.JSX.Element {
  const [over, setOver] = useState(false);
  const isDropTarget = DRAG_TARGETS.includes(status);
  return (
    <div className="flex h-full w-64 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <span>{label}</span>
        <span className="rounded bg-neutral-800 px-1.5 text-neutral-500">{cards.length}</span>
      </div>
      <div
        onDragOver={(e) => {
          if (!isDropTarget) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (isDropTarget) onDropCard(status);
        }}
        className={`flex flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-dashed p-2 transition-colors ${
          over ? 'border-blue-500 bg-blue-500/5' : 'border-neutral-800'
        }`}
      >
        {cards.map((c) => (
          <KanbanCard
            key={c.id}
            card={c}
            onOpen={onOpen}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  );
}
