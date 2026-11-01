import type { ReactNode } from 'react';
import type { WorkflowProgram } from '../../../../shared/workflows';
import {
  hasChange,
  type ReviewAgent,
  type ReviewLine,
  type ReviewSetting,
  type ReviewStatus,
  type WorkflowReview
} from './workflow-review';
import { Badge, SectionTitle } from './parts';

const LINE_CLASS: Record<ReviewLine['sign'], string> = {
  '+': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200',
  '-': 'bg-red-500/10 text-red-700 dark:text-red-200',
  ' ': 'text-fleet-text-secondary'
};

const PROGRAM_LABELS: Record<WorkflowProgram, string> = {
  pi: 'Pi',
  claude: 'Claude Code'
};

const STATUS_BADGES: Partial<
  Record<ReviewStatus, { tone: 'amber' | 'green' | 'red'; label: string }>
> = {
  changed: { tone: 'amber', label: 'Changed' },
  new: { tone: 'green', label: 'New' },
  removed: { tone: 'red', label: 'Removed' }
};

/** Long lines wrap, and the plus and minus signs stay out of a copied selection. */
export function ReviewLines({
  lines,
  className = ''
}: {
  lines: ReviewLine[];
  className?: string;
}): React.JSX.Element {
  const marked = hasChange(lines);
  return (
    <div className={`text-xs leading-relaxed ${className}`}>
      {lines.map((line, index) => (
        <div
          key={index}
          className={`flex gap-2 px-3 first:pt-2 last:pb-2 ${LINE_CLASS[line.sign]}`}
        >
          {marked && (
            <span className="w-2 flex-shrink-0 select-none opacity-60">
              {line.sign === ' ' ? '' : line.sign}
            </span>
          )}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {line.text === '' ? ' ' : line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function Card({
  title,
  badges,
  lines
}: {
  title: string;
  badges?: ReactNode;
  lines: ReviewLine[];
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-md border border-fleet-border">
      <header className="flex items-center gap-2 border-b border-fleet-border bg-fleet-surface-2/40 px-3 py-2">
        <h4 className="min-w-0 flex-1 break-words text-xs font-medium text-fleet-text">{title}</h4>
        {badges}
      </header>
      <ReviewLines lines={lines} />
    </section>
  );
}

function ProgramBadge({ agent }: { agent: ReviewAgent }): React.JSX.Element {
  const label = PROGRAM_LABELS[agent.program];
  if (!agent.wasProgram) return <Badge tone="gray">{label}</Badge>;
  return (
    <Badge tone="amber">
      {PROGRAM_LABELS[agent.wasProgram]} to {label}
    </Badge>
  );
}

function AgentCard({ agent }: { agent: ReviewAgent }): React.JSX.Element {
  const status = STATUS_BADGES[agent.status];
  return (
    <Card
      title={agent.role}
      lines={agent.lines}
      badges={
        <>
          {agent.last && <Badge tone="blue">Goes last</Badge>}
          <ProgramBadge agent={agent} />
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </>
      }
    />
  );
}

function SettingValue({ setting }: { setting: ReviewSetting }): React.JSX.Element {
  if (setting.was === undefined) return <>{setting.value}</>;
  return (
    <>
      <span className="block text-red-700 line-through dark:text-red-200">{setting.was}</span>
      <span className="block text-emerald-700 dark:text-emerald-200">{setting.value}</span>
    </>
  );
}

function Settings({ settings }: { settings: ReviewSetting[] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-fleet-border px-3 py-2.5 text-xs leading-relaxed">
      {settings.map((setting) => (
        <div key={setting.label} className="contents">
          <dt className="text-fleet-text-muted">{setting.label}</dt>
          <dd className="whitespace-pre-line break-words text-fleet-text-secondary">
            <SettingValue setting={setting} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What the workflow does, from the parsed file, so a person reads what will run. */
export function ReviewSections({ review }: { review: WorkflowReview }): React.JSX.Element {
  const staying = review.agents.filter((agent) => agent.status !== 'removed').length;
  return (
    <div className="space-y-4">
      <Settings settings={review.settings} />

      {review.shared.length > 0 && (
        <div>
          <SectionTitle>Shared instructions</SectionTitle>
          <Card
            title="Every agent reads this"
            lines={review.shared}
            badges={hasChange(review.shared) && <Badge tone="amber">Changed</Badge>}
          />
        </div>
      )}

      <div>
        <SectionTitle>Agents ({staying})</SectionTitle>
        <div className="space-y-3">
          {review.agents.map((agent) => (
            <AgentCard key={agent.role} agent={agent} />
          ))}
        </div>
      </div>
    </div>
  );
}
