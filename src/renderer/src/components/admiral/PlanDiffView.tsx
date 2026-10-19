import type { PreviousPlanVersion } from '../../../../shared/agency-jobs';
import { Toggle } from '../agent/settings/Toggle';
import { STATUS_WORD, type StepMark } from './plan-diff';

/**
 * What changed since the version before: what became of it, the client's
 * note on it, Show changes, and a way to read it.
 */
export function PlanDiffView({
  previous,
  shown,
  onShow,
  onSeeBefore
}: {
  previous: PreviousPlanVersion;
  shown: boolean;
  onShow: (shown: boolean) => void;
  /** Absent when the version before is not in the job's detail. */
  onSeeBefore: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-blue-400/40 bg-blue-500/5 px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 text-fleet-text-secondary">
          Changes since v{previous.version} ({STATUS_WORD[previous.status]})
        </span>
        {onSeeBefore !== undefined && (
          <button
            type="button"
            onClick={onSeeBefore}
            className="shrink-0 rounded text-blue-600 transition-colors hover:text-blue-500 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
          >
            See v{previous.version}
          </button>
        )}
        <label htmlFor="plan-show-changes" className="shrink-0 text-fleet-text-muted">
          Show changes
        </label>
        <Toggle id="plan-show-changes" checked={shown} onChange={onShow} />
      </div>
      {previous.note !== null && (
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
            YOU SAID
          </span>
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-fleet-text">
            {previous.note}
          </p>
        </div>
      )}
    </div>
  );
}

const MARK_TAG = 'rounded px-1.5 text-[10px] leading-4 font-semibold tracking-[0.04em]';
const BLUE_TAG = `${MARK_TAG} bg-blue-500/15 text-blue-700 dark:text-blue-300`;

/** A step's marks next to its title: New, Moved up or down, and what changed. */
export function StepTags({ mark }: { mark: StepMark | undefined }): React.JSX.Element | null {
  if (mark === undefined) return null;
  return (
    <>
      {mark.added && (
        <span className={`${MARK_TAG} bg-green-500/15 text-green-700 dark:text-green-300`}>
          NEW
        </span>
      )}
      {mark.moved !== null && <span className={BLUE_TAG}>MOVED {mark.moved.toUpperCase()}</span>}
      {mark.changed.length > 0 && (
        <span className={BLUE_TAG}>CHANGED: {mark.changed.join(', ').toUpperCase()}</span>
      )}
    </>
  );
}

/** An old value, struck through before the new one. */
export function Was({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <s className="mr-1 text-fleet-text-subtle">{children}</s>;
}

/** The steps the version before had and this one drops, each in a red dashed row. */
export function RemovedSteps({
  steps
}: {
  steps: Array<{ id: string; title: string }>;
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {steps.map((step) => (
        <li
          key={step.id}
          className="flex items-baseline gap-2 rounded-lg border border-dashed border-red-400/60 px-3.5 py-2 text-[13px]"
        >
          <span className="shrink-0 text-[11px] font-semibold tracking-[0.04em] text-red-600 dark:text-red-400">
            REMOVED
          </span>
          <span className="min-w-0 text-fleet-text-muted line-through">{step.title}</span>
        </li>
      ))}
    </ul>
  );
}
