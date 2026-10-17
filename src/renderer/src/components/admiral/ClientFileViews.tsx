import { useState } from 'react';
import { CircleAlert, Minus, Plus } from 'lucide-react';
import type { ClientFileProposal } from '../../../../shared/agency';
import { openClientFileSettings } from '../../store/settings-nav-store';
import { PRIMARY, SECONDARY } from './JobClose';

function Line({ sign, text }: { sign: 'add' | 'remove'; text: string }): React.JSX.Element {
  const Icon = sign === 'add' ? Plus : Minus;
  return (
    <li className="flex items-start gap-1.5">
      <Icon
        size={11}
        aria-label={sign === 'add' ? 'Add' : 'Remove'}
        className={`mt-[3px] shrink-0 ${sign === 'add' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}
      />
      <span
        className={
          sign === 'add' ? 'text-fleet-text' : 'text-fleet-text-subtle line-through decoration-1'
        }
      >
        {text}
      </span>
    </li>
  );
}

/**
 * What a client file card would change: a contradicted line struck out right
 * above the line that replaces it, then the removals, then the new lines.
 */
export function ProposalLines({ proposal }: { proposal: ClientFileProposal }): React.JSX.Element {
  const replaced = proposal.add.filter((a) => a.replaces !== null);
  const added = proposal.add.filter((a) => a.replaces === null);
  return (
    <ul
      aria-label="Client file changes"
      className="flex flex-col gap-1 rounded border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs leading-snug"
    >
      {replaced.map((a, i) => (
        <li key={`r${i}`} className="flex flex-col gap-0.5">
          <ul className="flex flex-col gap-0.5">
            <Line sign="remove" text={a.replaces ?? ''} />
            <Line sign="add" text={a.text} />
          </ul>
        </li>
      ))}
      {proposal.remove.map((text, i) => (
        <Line key={`d${i}`} sign="remove" text={text} />
      ))}
      {added.map((a, i) => (
        <Line key={`a${i}`} sign="add" text={a.text} />
      ))}
    </ul>
  );
}

/**
 * The client file changed outside Fleet: by hand in an editor, or by
 * something else on this machine. The Admiral keeps Fleet's last version
 * until the client looks at the change and keeps it.
 */
export function ClientFileNotice({ repoId }: { repoId: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <section
      aria-label="The client file changed outside Fleet"
      className="flex flex-col gap-1.5 rounded-md border border-amber-400/35 bg-fleet-bg p-2.5"
    >
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-fleet-text">
        <CircleAlert size={13} className="shrink-0 text-amber-700 dark:text-amber-400" />
        The client file changed outside Fleet
      </div>
      <p className="text-xs leading-relaxed text-fleet-text-muted">
        Until you keep the change, the Admiral works from the version Fleet last wrote.
      </p>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <button type="button" onClick={() => openClientFileSettings(repoId)} className={PRIMARY}>
          Review
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.fleet.agency.projects.keepClientFile(repoId).finally(() => setBusy(false));
          }}
          className={SECONDARY}
        >
          Keep the change
        </button>
      </div>
    </section>
  );
}
