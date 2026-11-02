import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  AgentState,
  RunState,
  WorkflowApproval,
  WorkflowScope
} from '../../../../shared/workflows';
import { showWorkflowError } from '../../store/workflows-store';

type Tone = 'plain' | 'primary' | 'danger' | 'quiet';

const TONES: Record<Tone, string> = {
  plain: 'border border-fleet-border-strong text-fleet-text-secondary hover:bg-fleet-surface-2',
  primary: 'bg-[var(--fleet-accent)] text-white hover:bg-[var(--fleet-accent-hover)]',
  danger: 'border border-red-500/40 text-red-300 hover:bg-red-500/10',
  quiet: 'text-fleet-text-muted hover:bg-fleet-surface-2 hover:text-fleet-text'
};

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  tone?: Tone;
  onClick?: () => unknown;
};

/** When `onClick` returns a promise, the button waits for it and shows a failure. */
export function Button({
  tone = 'plain',
  className = '',
  disabled = false,
  onClick,
  ...props
}: ButtonProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const press = (): void => {
    const result = onClick?.();
    if (!(result instanceof Promise)) return;
    setBusy(true);
    void result.catch(showWorkflowError).finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition active:scale-95 disabled:pointer-events-none disabled:opacity-40 ${TONES[tone]} ${className}`}
      disabled={disabled || busy}
      onClick={press}
      {...props}
    />
  );
}

export const FIELD_CLASS =
  'w-full rounded border border-fleet-border-strong bg-fleet-surface px-2 py-1.5 text-xs text-fleet-text placeholder:text-fleet-text-subtle focus:border-[var(--fleet-accent)] focus:outline-none';

/** A count of 1 or more. It applies on blur, so a person can clear it and type. */
export function CountInput({
  value,
  onChange,
  className = ''
}: {
  value: number;
  onChange: (value: number) => void;
  className?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);

  const apply = (): void => {
    if (draft !== null) onChange(Math.max(1, Number(draft) || 1));
    setDraft(null);
  };

  return (
    <input
      type="number"
      min={1}
      className={`${FIELD_CLASS} ${className}`}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-fleet-text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-fleet-text-subtle">{hint}</span>}
    </label>
  );
}

type BadgeTone = 'green' | 'blue' | 'amber' | 'red' | 'gray';

const BADGES: Record<BadgeTone, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  red: 'bg-red-500/10 text-red-700 dark:text-red-300',
  gray: 'bg-fleet-surface-2 text-fleet-text-muted'
};

export function Badge({
  tone,
  children
}: {
  tone: BadgeTone;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 align-middle text-[11px] leading-4 ${BADGES[tone]}`}
    >
      {children}
    </span>
  );
}

const RUN_BADGES: Record<RunState, { tone: BadgeTone; label: string }> = {
  queued: { tone: 'gray', label: 'Queued' },
  preparing: { tone: 'blue', label: 'Starting' },
  running: { tone: 'blue', label: 'Running' },
  'needs-you': { tone: 'amber', label: 'Needs you' },
  finished: { tone: 'green', label: 'Finished' },
  stopped: { tone: 'gray', label: 'Stopped' },
  'cut-off': { tone: 'amber', label: 'Cut off' },
  closed: { tone: 'gray', label: 'Closed' }
};

export function RunBadge({ state }: { state: RunState }): React.JSX.Element {
  const { tone, label } = RUN_BADGES[state];
  return <Badge tone={tone}>{label}</Badge>;
}

const AGENT_BADGES: Record<AgentState, { tone: BadgeTone; label: string }> = {
  pending: { tone: 'gray', label: 'Waiting to start' },
  starting: { tone: 'blue', label: 'Starting' },
  working: { tone: 'blue', label: 'Working' },
  waiting: { tone: 'gray', label: 'Waiting' },
  done: { tone: 'green', label: 'Done' },
  failed: { tone: 'red', label: 'Failed' },
  skipped: { tone: 'gray', label: 'Skipped' }
};

export function AgentBadge({ state }: { state: AgentState }): React.JSX.Element {
  const { tone, label } = AGENT_BADGES[state];
  return <Badge tone={tone}>{label}</Badge>;
}

const APPROVAL_BADGES: Record<WorkflowApproval, { tone: BadgeTone; label: string }> = {
  approved: { tone: 'green', label: 'Ready' },
  'needs-approval': { tone: 'amber', label: 'Needs approval' },
  changed: { tone: 'amber', label: 'Changed' }
};

export function ApprovalBadge({ approval }: { approval: WorkflowApproval }): React.JSX.Element {
  const { tone, label } = APPROVAL_BADGES[approval];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Empty({
  title,
  children
}: {
  title: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md py-14 text-center">
      <div className="text-sm font-medium text-fleet-text-secondary">{title}</div>
      {children && <div className="mt-2 text-xs text-fleet-text-subtle">{children}</div>}
    </div>
  );
}

export function SectionTitle({
  children,
  right
}: {
  children: ReactNode;
  right?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 pb-2">
      <h3 className="text-xs font-medium text-fleet-text-secondary">{children}</h3>
      {right}
    </div>
  );
}

const SCOPE_ON: Record<WorkflowScope, string> = {
  project: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  personal: 'bg-orange-500/15 text-orange-700 dark:text-orange-300'
};

/**
 * Where a file is, as a switch. Pressing the other side picks it: a row moves
 * the file there, and the editor saves it there.
 */
export function ScopeSwitch({
  scope,
  verb,
  busy = false,
  onPick
}: {
  scope: WorkflowScope;
  /** What a press does, such as "Move to". */
  verb: string;
  busy?: boolean;
  onPick: (scope: WorkflowScope) => unknown;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Location"
      aria-busy={busy || undefined}
      className="inline-flex rounded border border-fleet-border bg-fleet-bg p-0.5"
    >
      {(['project', 'personal'] as const).map((value) => {
        const on = scope === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            aria-disabled={on || busy || undefined}
            aria-label={on ? undefined : `${verb} ${value}`}
            title={on ? undefined : `${verb} ${value}`}
            onClick={on || busy ? undefined : () => onPick(value)}
            className={`rounded-sm px-2 py-0.5 text-[11px] capitalize transition ${
              on
                ? SCOPE_ON[value]
                : busy
                  ? 'cursor-wait text-fleet-text-subtle'
                  : 'text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text'
            }`}
          >
            {value}
          </button>
        );
      })}
    </div>
  );
}

/** Asks before a move or a save replaces the file of the same name in the other scope. */
export function ReplaceNotice({
  text,
  onCancel,
  onReplace
}: {
  text: string;
  onCancel: () => void;
  onReplace: () => unknown;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2"
    >
      <TriangleAlert
        size={13}
        className="shrink-0 text-amber-700 dark:text-amber-300"
        aria-hidden
      />
      <p className="flex-1 text-[11px] leading-relaxed text-fleet-text-secondary">{text}</p>
      <Button onClick={onCancel}>Cancel</Button>
      <Button tone="danger" onClick={onReplace}>
        Replace
      </Button>
    </div>
  );
}
