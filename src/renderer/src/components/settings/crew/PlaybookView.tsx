import type { CrewPlaybook } from '../../../../../shared/agency-crew';
import { SECONDARY } from '../../admiral/JobClose';
import { FileName } from './crew-file';
import { openCrewFile } from './open-file';
import { playbookLine, roleTitle, SOURCE_LABEL } from './role-draft';

/** A playbook as its file has it. Playbooks are edited in their file. */
export function PlaybookView({ playbook }: { playbook: CrewPlaybook }): React.JSX.Element {
  return (
    <section
      aria-label={`Playbook ${playbook.name}`}
      className="space-y-4 rounded-lg border border-fleet-border bg-fleet-surface px-5 py-4"
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2.5">
            <span className="text-[17px] font-semibold text-fleet-text">
              {roleTitle(playbook.name)}
            </span>
            <span className="shrink-0 rounded-full bg-fleet-surface-3 px-2 py-px text-[11px] text-fleet-text-muted">
              {SOURCE_LABEL[playbook.source]}
            </span>
          </div>
          <FileName path={playbook.path} />
        </div>
        <button
          type="button"
          onClick={() => openCrewFile(playbook.path)}
          className={`${SECONDARY} shrink-0 whitespace-nowrap`}
        >
          Open file
        </button>
      </div>
      <p className="text-sm text-fleet-text-secondary">{playbook.description}</p>
      <p className="text-xs text-fleet-text-muted">{playbookLine(playbook)}</p>
      <ol className="divide-y divide-fleet-border rounded-md border border-fleet-border bg-fleet-bg">
        {playbook.steps.map((step) => (
          <li key={step.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="w-24 shrink-0 font-mono text-xs text-fleet-text-muted">{step.id}</span>
            <span className="min-w-0 flex-1 text-fleet-text">
              {roleTitle(step.role)}
              {step.count > 1 ? ` ×${step.count}` : ''}
            </span>
            <span className="shrink-0 text-xs text-fleet-text-subtle">
              {step.after.length === 0 ? 'starts first' : `after ${step.after.join(', ')}`}
              {step.gate === 'client' ? ' · you check it' : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-fleet-text-subtle">
        The Admiral starts a plan from a playbook and fits it to the job. Edit the file to change
        the playbook.
      </p>
    </section>
  );
}
