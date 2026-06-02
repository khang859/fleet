import type { BoardCard } from '../../../../shared/kanban-types';
import { MessageSquare, GitBranch, Clock, PauseCircle, FileText } from 'lucide-react';
import { scheduleSummary, formatNextRun } from './kanban-utils';

type Props = {
  card: BoardCard;
  featureName?: string;
  onOpen: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
};

export function KanbanCard({
  card,
  featureName,
  onOpen,
  onDragStart,
  onDragEnd
}: Props): React.JSX.Element {
  const draggable = card.status !== 'running';
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        onDragStart(card.id);
      }}
      onDragEnd={() => onDragEnd()}
      onClick={() => onOpen(card.id)}
      className="group cursor-pointer rounded-md border border-neutral-700 bg-neutral-800/60 p-2 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-800 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-snug line-clamp-2">{card.title}</span>
        {card.status === 'running' && (
          <span
            className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-400"
            title="worker running"
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-400">
        <span className="font-mono text-neutral-500">{card.id}</span>
        {card.assignee && (
          <span className="rounded bg-teal-500/20 px-1 text-teal-300">{card.assignee}</span>
        )}
        {card.priority > 0 && (
          <span className="rounded bg-amber-500/20 px-1 text-amber-300">P{card.priority}</span>
        )}
        {card.tenant && (
          <span className="rounded bg-neutral-700 px-1 text-neutral-300">{card.tenant}</span>
        )}
        {featureName && (
          <span
            className="max-w-[10rem] truncate rounded bg-violet-500/20 px-1 text-violet-300"
            title={featureName}
          >
            {featureName}
          </span>
        )}
        {card.childTotal > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <GitBranch size={10} /> {card.childDone}/{card.childTotal}
          </span>
        )}
        {card.commentCount > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare size={10} /> {card.commentCount}
          </span>
        )}
        {card.artifactCount > 0 && (
          <span className="inline-flex items-center gap-0.5" title="output artifacts">
            <FileText size={10} /> {card.artifactCount}
          </span>
        )}
        {card.status === 'scheduled' && (
          <span
            className="inline-flex items-center gap-0.5 text-indigo-300"
            title={formatNextRun(card.nextRunAt)}
          >
            {card.schedulePaused ? <PauseCircle size={10} /> : <Clock size={10} />}
            {scheduleSummary(card)}
          </span>
        )}
      </div>
    </div>
  );
}
