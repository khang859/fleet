import { Fragment, type ReactNode } from 'react';
import { ArrowDown, ArrowRight } from 'lucide-react';
import { stagesOf, type WorkflowAgentDef, type WorkflowDef } from '../../../../shared/workflows';
import { PROGRAM_LABELS } from './workflow-review';
import { finishNote } from './stage-notes';
import { Badge } from './parts';

export type MapColumn = {
  key: string;
  title: ReactNode;
  note?: string;
  /** Start and End are not stages, so they sit back from the map. */
  quiet?: boolean;
  children: ReactNode;
};

function ColumnBox({
  column,
  stacked
}: {
  column: MapColumn;
  stacked: boolean;
}): React.JSX.Element {
  return (
    <section
      className={`flex flex-col gap-2 rounded-lg p-2.5 ${stacked ? 'w-full' : 'w-52 flex-shrink-0'} ${
        column.quiet ? 'bg-fleet-surface/40' : 'bg-fleet-surface-2/50'
      }`}
    >
      <div className={stacked ? '' : 'min-h-9'}>
        <div className="text-xs font-semibold text-fleet-text">{column.title}</div>
        {column.note && <p className="text-[11px] text-fleet-text-subtle">{column.note}</p>}
      </div>
      {stacked && column.children ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
          {column.children}
        </div>
      ) : (
        column.children
      )}
    </section>
  );
}

/** A pane beside a terminal is narrow, so its map runs top to bottom. */
function StackedColumns({ columns }: { columns: MapColumn[] }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center">
      {columns.map((column, index) => (
        <Fragment key={column.key}>
          <ColumnBox column={column} stacked />
          {index < columns.length - 1 && (
            <ArrowDown size={14} className="my-1 text-fleet-text-subtle" aria-hidden />
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** The columns of a map, left to right, in run order. The page scrolls them when it is narrow. */
export function StageColumns({
  columns,
  between
}: {
  columns: MapColumn[];
  /** What sits between two columns, besides the arrow. */
  between?: (index: number) => ReactNode;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex min-w-max items-stretch">
        {columns.map((column, index) => (
          <Fragment key={column.key}>
            <ColumnBox column={column} stacked={false} />
            {index < columns.length - 1 && (
              <div className="flex w-9 flex-shrink-0 flex-col items-center justify-center gap-1">
                <ArrowRight size={14} className="text-fleet-text-subtle" aria-hidden />
                {between?.(index)}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** What a card shows besides its name, so a person can read the map with no click. */
export function AgentChips({ agent }: { agent: WorkflowAgentDef }): React.JSX.Element {
  return (
    <span className="flex flex-wrap gap-1">
      {agent.access === 'write' ? (
        <Badge tone="amber">Changes code</Badge>
      ) : (
        <Badge tone="gray">Read only</Badge>
      )}
      {agent.talks && <Badge tone="blue">Talks with you</Badge>}
      {agent.plan && <Badge tone="blue">Plan approval</Badge>}
      {agent.resume && <Badge tone="gray">Goes on from {agent.resume}</Badge>}
    </span>
  );
}

/** A map to read, with no way to change it. */
export function ReadOnlyMap({ def }: { def: WorkflowDef }): React.JSX.Element {
  return (
    <StackedColumns
      columns={[
        ...stagesOf(def).map((stage, index) => ({
          key: `stage-${index}`,
          title: stage.name,
          note: stage.only_with_findings ? 'Only with findings' : undefined,
          children: stage.agents.map((agent, at) => (
            <div key={at} className="space-y-1 rounded-md border border-fleet-border p-2">
              <div className="truncate text-xs font-medium text-fleet-text">{agent.role}</div>
              <div className="text-[11px] text-fleet-text-subtle">
                {PROGRAM_LABELS[agent.program]}
              </div>
              <AgentChips agent={agent} />
            </div>
          ))
        })),
        {
          key: 'end',
          title: 'End',
          note: finishNote(def),
          quiet: true,
          children: null
        }
      ]}
    />
  );
}
