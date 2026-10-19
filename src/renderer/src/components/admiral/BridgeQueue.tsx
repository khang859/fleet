import { useState } from 'react';
import { Check, CircleCheck } from 'lucide-react';
import type { AgencySnapshot, ClientDecision, HeldDecision } from '../../../../shared/agency';
import { jobDisplayId } from '../../../../shared/agency';
import { useNow } from '../../hooks/use-now';
import type { Reading, RefusedDecision } from '../../store/bridge-store';
import { ClientFileNotice } from './ClientFileViews';
import {
  HowAJobGoes,
  JOB_SHEET_WIDTH_PX,
  LeftoversSection,
  Section,
  SettingsBox,
  SIDE_COLUMN
} from './JobSheet';
import { PastJobList } from './PastJobs';
import { QueueCard, RefusalLine } from './QueueCard';
import { jobStatus, leftText } from './job-view';
import type { WaitingItem } from './waiting-queue';

/** How many of today's decisions show before All. */
const DONE_ROWS = 5;

/**
 * The Bridge's right-hand column: everything that waits on the client across
 * the project's open jobs, soonest to expire first, so no job tab needs
 * opening to answer it. A click on a card, outside its buttons, reads it in
 * full. Below it, what the client decided today, then what the lobby sheet
 * showed: the client file notice, leftovers and past jobs.
 */
export function BridgeQueue({
  snapshot,
  items,
  refused,
  reading,
  defaultBudgetUsd,
  onRead,
  onOpenJob,
  onOpenSettings,
  className = ''
}: {
  snapshot: AgencySnapshot | undefined;
  /** From `useBridgeQueue`, in queue order. */
  items: WaitingItem[];
  refused: RefusedDecision[];
  /** The item the reader shows; null while the conversation shows. */
  reading: Reading | null;
  defaultBudgetUsd: number;
  onRead: (key: string) => void;
  onOpenJob: (jobId: number) => void;
  onOpenSettings: () => void;
  className?: string;
}): React.JSX.Element {
  const jobs = snapshot?.jobs ?? [];
  const readingKey = reading?.key ?? null;
  const held = snapshot?.held ?? [];
  const keys = new Set(items.map((i) => i.key));
  const firstRun = jobs.length === 0;

  return (
    <aside
      aria-label="Waiting on you"
      style={{ width: JOB_SHEET_WIDTH_PX }}
      className={`${SIDE_COLUMN} ${className}`}
    >
      <Section
        label={`WAITING ON YOU · ${items.length}`}
        tone={items.length > 0 ? 'amber' : 'muted'}
      >
        {snapshot !== undefined &&
          refused
            .filter((r) => !keys.has(r.key))
            .map((r) => (
              <div key={r.key} className="rounded-md border border-fleet-border bg-fleet-bg p-2.5">
                <RefusalLine repoId={snapshot.repoId} refusal={r} />
              </div>
            ))}
        {snapshot !== undefined && items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              // The card's Read button is the keyboard's way in; a click
              // anywhere else on the card is the mouse's.
              <li
                key={item.key}
                onClick={(e) => {
                  if (item.kind !== 'loading' && !onControl(e.target)) onRead(item.key);
                }}
                className={`rounded-md ${item.kind === 'loading' ? '' : 'cursor-pointer'} ${
                  readingKey === item.key ? 'ring-2 ring-blue-400/50' : ''
                }`}
              >
                <QueueCard
                  item={item}
                  job={jobs.find((j) => j.id === item.jobId) ?? null}
                  snapshot={snapshot}
                  refusal={refused.find((r) => r.key === item.key) ?? null}
                  reading={readingKey === item.key}
                  onRead={() => onRead(item.key)}
                  onOpenJob={onOpenJob}
                  onOpenSettings={onOpenSettings}
                />
              </li>
            ))}
          </ul>
        )}
        {held.map((decision) => (
          <HeldRow key={decision.id} decision={decision} />
        ))}
        {items.length === 0 && held.length === 0 && <AllClear />}
      </Section>

      <DoneToday decisions={snapshot?.decisions ?? []} />

      {snapshot?.clientFileChanged === true && <ClientFileNotice repoId={snapshot.repoId} />}

      {firstRun && <HowAJobGoes trust={snapshot?.trust.level ?? 'ask'} />}

      <LeftoversSection snapshot={snapshot} />

      {snapshot !== undefined && snapshot.pastJobs.length > 0 && (
        <Section label="PAST JOBS">
          <PastJobList jobs={snapshot.pastJobs} />
        </Section>
      )}

      <div className="flex-1" />
      <SettingsBox
        budgetLabel="Default budget"
        budgetUsd={defaultBudgetUsd}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}

/** Whether a click landed on a control of its own, which a click on the card must not read. */
function onControl(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, textarea, select, label, summary') !== null
  );
}

/** A decision the client gave from the Bridge, waiting its few seconds for Undo. */
function HeldRow({ decision }: { decision: HeldDecision }): React.JSX.Element {
  const now = useNow(true);
  const [undoing, setUndoing] = useState(false);
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-md bg-fleet-bg px-2.5 py-1.5 text-xs text-fleet-text-muted"
    >
      <Check size={13} aria-hidden className="shrink-0 text-green-500" />
      <span className="min-w-0 flex-1 truncate">
        {decision.label}
        {decision.jobId !== null && (
          <span>
            {' '}
            · <span className="font-mono text-[11px]">{jobDisplayId(decision.jobId)}</span>
          </span>
        )}
      </span>
      <button
        type="button"
        disabled={undoing}
        onClick={() => {
          setUndoing(true);
          void window.fleet.agency.undo(decision.id).finally(() => setUndoing(false));
        }}
        className="h-6 shrink-0 rounded-md border border-fleet-border-strong px-2 text-[11px] text-fleet-text-secondary tabular-nums transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring disabled:opacity-50"
      >
        Undo · {leftText(decision.runsAt - now)}
      </button>
    </div>
  );
}

function AllClear(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-fleet-border-strong px-4 py-6 text-center">
      <CircleCheck size={20} aria-hidden className="text-green-500" />
      <span className="text-[13px] font-semibold text-fleet-text">Nothing waits on you</span>
      <span className="max-w-[260px] text-xs leading-relaxed text-fleet-text-muted">
        New plans, questions and permissions show here. The Bridge tab gets a badge.
      </span>
    </div>
  );
}

/** What the client decided since midnight, newest first, with where each job is now. */
function DoneToday({ decisions }: { decisions: ClientDecision[] }): React.JSX.Element | null {
  const [all, setAll] = useState(false);
  if (decisions.length === 0) return null;
  const more = decisions.length > DONE_ROWS;
  return (
    <Section
      label="DONE TODAY"
      gap="gap-1"
      action={
        more && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="shrink-0 rounded text-[11px] font-medium text-fleet-text-muted transition-colors hover:text-fleet-text focus-ring"
          >
            {all ? 'Fewer' : `All ${decisions.length}`}
          </button>
        )
      }
    >
      <ul className="flex flex-col">
        {(all ? decisions : decisions.slice(0, DONE_ROWS)).map((d) => (
          <li
            key={d.key}
            className="flex items-center gap-2 border-b border-fleet-border/60 py-1.5 text-xs last:border-b-0"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-green-400" />
            <span
              className="min-w-0 flex-1 truncate text-fleet-text-muted"
              title={d.detail === null ? d.label : `${d.label} · ${d.detail}`}
            >
              {d.label}
              {d.detail !== null && <span className="text-fleet-text"> · {d.detail}</span>}
              {d.jobId !== null && (
                <span>
                  {' '}
                  · <span className="font-mono text-[11px]">{jobDisplayId(d.jobId)}</span>
                </span>
              )}
            </span>
            {d.jobState !== null && (
              <span className="shrink-0 text-[11px] text-fleet-text-subtle">
                {jobStatus({ state: d.jobState }, { asking: false, working: false }).label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
