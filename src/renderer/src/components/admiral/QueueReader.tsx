import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { AgencySnapshot } from '../../../../shared/agency';
import { holdAnswer, type Reading, type RefusedDecision } from '../../store/bridge-store';
import { NeedsYouCard } from './JobSheet';
import { DeliveredCard } from './JobClose';
import { PermissionCard } from './PermissionCard';
import { PlanReader } from './PlanReader';
import { QueueHead, RefusalLine } from './QueueCard';
import { QuestionCard } from './QuestionCard';
import { ReaderFrame } from './ReaderFrame';
import { SettingsCardView } from './SettingsCard';
import { crewPaneId } from './job-view';
import { closesReader } from './use-bridge-queue';
import { kindLabel, type WaitingItem } from './waiting-queue';

/**
 * The Bridge reader: one queue item in full in the main column, over the
 * conversation, which stays as the client left it. Its header names the item
 * and its place in the queue, with Previous, Next and Close; Esc closes it
 * too, outside a text field.
 */
export function QueueReader({
  reading,
  snapshot,
  ...props
}: Omit<ReaderProps, 'reading' | 'snapshot'> & {
  /** Null while the conversation shows. */
  reading: Reading | null;
  snapshot: AgencySnapshot | undefined;
}): React.JSX.Element | null {
  if (reading === null || snapshot === undefined) return null;
  return <OpenReader reading={reading} snapshot={snapshot} {...props} />;
}

type ReaderProps = {
  items: readonly WaitingItem[];
  /** Kept on the queue by `useQueueReading`, so `reading.index` is in range. */
  reading: Reading;
  snapshot: AgencySnapshot;
  refused: RefusedDecision[];
  /** Shows another item by its key, or the conversation on null. */
  onRead: (key: string | null) => void;
  onOpenSettings: () => void;
};

function OpenReader({
  items,
  reading,
  snapshot,
  refused,
  onRead,
  onOpenSettings
}: ReaderProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const item = items[reading.index];
  const job = snapshot.jobs.find((j) => j.id === item.jobId) ?? null;
  const refusal = refused.find((r) => r.key === item.key) ?? null;
  const kind = kindLabel(item);

  // Focus follows the reader in, and stays in it when the item on screen
  // leaves the queue and takes the focused button with it.
  useEffect(() => {
    const el = ref.current;
    if (el !== null && !el.contains(document.activeElement)) el.focus();
  }, [item.key]);

  const head = (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <QueueHead kind={kind} job={job} at={null} />
        </div>
        <span className="shrink-0 text-[11px] text-fleet-text-subtle tabular-nums">
          {reading.index + 1} of {items.length} waiting
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <NavButton
            label="Previous"
            disabled={reading.index === 0}
            onClick={() => onRead(items[reading.index - 1].key)}
          >
            <ChevronUp size={14} />
          </NavButton>
          <NavButton
            label="Next"
            disabled={reading.index === items.length - 1}
            onClick={() => onRead(items[reading.index + 1].key)}
          >
            <ChevronDown size={14} />
          </NavButton>
          <NavButton label="Close" onClick={() => onRead(null)}>
            <X size={13} />
          </NavButton>
        </div>
      </div>
      {refusal !== null && <RefusalLine repoId={snapshot.repoId} refusal={refusal} />}
    </div>
  );

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label={`Reading ${kind.toLowerCase()}`}
      onKeyDown={(e) => {
        if (!closesReader(e)) return;
        e.preventDefault();
        onRead(null);
      }}
      className="absolute inset-0 flex bg-fleet-bg outline-none"
    >
      {/* Keyed, so a draft note or a ticked option stays with its item. */}
      <ReaderBody
        key={item.key}
        item={item}
        head={head}
        snapshot={snapshot}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

/** The item in full: a reader of its own for plans, permissions and questions, else its card. */
function ReaderBody({
  item,
  head,
  snapshot,
  onOpenSettings
}: {
  item: WaitingItem;
  head: React.ReactNode;
  snapshot: AgencySnapshot;
  onOpenSettings: () => void;
}): React.JSX.Element {
  switch (item.kind) {
    case 'plan':
      return <PlanReader version={item.version} detail={item.detail} head={head} />;
    case 'permission':
      return (
        <PermissionCard
          layout="reader"
          permission={item.permission}
          paneId={crewPaneId(item.detail, item.permission.crewId)}
          results={item.detail.results}
          head={head}
        />
      );
    case 'question':
      return (
        <QuestionCard
          layout="reader"
          question={item.question}
          head={head}
          clientFileChanged={snapshot.clientFileChanged}
          onOpenSettings={onOpenSettings}
          onAnswer={holdAnswer(snapshot.repoId, item.question)}
        />
      );
    case 'settings':
      return (
        <ReaderFrame head={head}>
          <SettingsCardView card={item.card} />
        </ReaderFrame>
      );
    case 'delivered':
      return (
        <ReaderFrame head={head}>
          <DeliveredCard job={item.job} detail={item.detail} />
        </ReaderFrame>
      );
    case 'crew':
      return (
        <ReaderFrame head={head}>
          <NeedsYouCard member={item.member} />
        </ReaderFrame>
      );
    case 'loading':
      return (
        <ReaderFrame head={head}>
          <p aria-busy className="text-xs text-fleet-text-subtle">
            Loading…
          </p>
        </ReaderFrame>
      );
  }
}

function NavButton({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-fleet-text-muted transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fleet-text-muted"
    >
      {children}
    </button>
  );
}
