import { useState } from 'react';
import { CircleAlert, Compass } from 'lucide-react';
import {
  draftOf,
  type CrewRole,
  type CrewRuntimeView,
  type RoleDraft
} from '../../../../../shared/agency-crew';
import { PRIMARY, SECONDARY } from '../../admiral/JobClose';
import { FileName } from './crew-file';
import { openCrewFile } from './open-file';
import { ModelField, RuntimeChoice } from './RuntimeFields';
import {
  draftProblem,
  EMPTY_ROLE,
  roleTitle,
  sameDraft,
  SOURCE_LABEL,
  switchNote,
  switchRuntime
} from './role-draft';

const FIELD =
  'w-full rounded-md border border-fleet-border-strong bg-fleet-bg px-2.5 py-1.5 text-sm text-fleet-text placeholder:text-fleet-text-subtle focus-ring';
const CAPTION = 'text-xs text-fleet-text-muted';

/**
 * One role's editor: when to hire it, the runtime and model it runs on, and
 * its instructions. Nothing reaches the file until Save; Discard drops the
 * draft. A bundled role saves as the user's own copy.
 */
export function RoleEditor(props: {
  repoId: string;
  /** Null for a new role. */
  role: CrewRole | null;
  draft: RoleDraft | undefined;
  onDraft: (draft: RoleDraft | null) => void;
  onSaved: (name: string) => void;
  /** Drops the draft and reads the role's file again. */
  onDiscard: () => void;
  runtimes: CrewRuntimeView[] | null;
  /** Every role as its draft has it. */
  roles: RoleDraft[];
}): React.JSX.Element {
  const { role, runtimes } = props;
  const saved = role === null ? EMPTY_ROLE : draftOf(role);
  const value = props.draft ?? saved;
  const dirty = !sameDraft(value, saved);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const view = runtimes?.find((r) => r.check.runtime === value.runtime);
  const problem = dirty ? draftProblem(value) : null;
  // A new role has no saved runtime to switch from.
  const note = role === null ? null : switchNote(value, saved);

  const edit = (patch: Partial<RoleDraft>): void => {
    setRefused(null);
    const next = { ...value, ...patch };
    props.onDraft(sameDraft(next, saved) ? null : next);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.fleet.agency.crew.saveRole({
        repoId: props.repoId,
        base: role === null ? null : saved,
        role: value
      });
      if (result.ok) props.onSaved(value.name);
      else setRefused(result.reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={role === null ? 'New role' : `Role ${role.name}`}
      className="@container space-y-4 rounded-lg border border-fleet-border bg-fleet-surface px-5 py-4"
    >
      <RoleHead role={role} name={value.name} onName={(name) => edit({ name })} />
      {role?.source === 'bundled' && (
        <p className={CAPTION}>
          Fleet ships this role. Saving makes it your own copy in ~/.fleet/crew, for all projects.
        </p>
      )}
      {role === null && (
        <p className={CAPTION}>Saving puts the role in this project&apos;s crew in Fleet.</p>
      )}

      <label className="block space-y-1">
        <span className={CAPTION}>When to hire (the Admiral reads this)</span>
        <textarea
          value={value.description}
          onChange={(e) => edit({ description: e.target.value })}
          rows={3}
          className={`${FIELD} block resize-y`}
        />
      </label>

      <div className="space-y-2">
        <span className={CAPTION}>Runs on</span>
        <RuntimeChoice
          value={value.runtime}
          runtimes={runtimes}
          onPick={(runtime) => edit(switchRuntime(value, runtime, saved))}
        />
        <ModelField
          draft={value}
          view={view}
          roles={props.roles}
          onModel={(model) => edit({ model })}
        />

        {note !== null && (
          <p className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-400/[0.08] px-2.5 py-2 text-xs text-fleet-text-secondary">
            <CircleAlert size={13} className="mt-px shrink-0 text-amber-500 dark:text-amber-400" />
            <span>{note}</span>
          </p>
        )}
      </div>

      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={value.stack}
          onChange={(e) => edit({ stack: e.target.checked })}
          className="fleet-accent-input mt-0.5"
        />
        <span className="space-y-px">
          <span className="block text-sm text-fleet-text">Runs the project&apos;s servers</span>
          <span className="block text-xs text-fleet-text-muted">
            Its steps wait for a stack slot, so two jobs never start the stack at once.
          </span>
        </span>
      </label>

      <p className="flex items-start gap-2 rounded-md bg-fleet-bg px-2.5 py-2 text-xs text-fleet-text-muted">
        <Compass size={13} className="mt-px shrink-0 text-blue-500 dark:text-blue-400" />
        <span>
          The Admiral picks each step&apos;s crew, what it hands back, and when you check the work.
          You see all of it on the plan before anything runs.
        </span>
      </p>

      <label className="block space-y-1">
        <span className={CAPTION}>Instructions</span>
        <textarea
          value={value.instructions}
          onChange={(e) => edit({ instructions: e.target.value })}
          spellCheck={false}
          placeholder={'You are a Data migrator.\n\nWrite the migration, then run it on a copy.'}
          className={`${FIELD} block h-64 resize-y font-mono text-xs leading-relaxed`}
        />
      </label>

      <SaveBar
        status={refused ?? problem ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
        tone={refused !== null || problem !== null ? 'error' : dirty ? 'dirty' : 'clean'}
        canDiscard={dirty && !busy}
        canSave={dirty && !busy && problem === null}
        onDiscard={() => {
          setRefused(null);
          props.onDiscard();
        }}
        onSave={() => void save()}
      />
    </section>
  );
}

/** The role's name (an input for a new role), where it comes from, and its file. */
function RoleHead(props: {
  role: CrewRole | null;
  name: string;
  onName: (name: string) => void;
}): React.JSX.Element {
  const { role } = props;
  return (
    <div className="flex items-start gap-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2.5">
          {role === null ? (
            <input
              aria-label="Role name"
              value={props.name}
              onChange={(e) => props.onName(e.target.value.trim())}
              placeholder="data-migrator"
              spellCheck={false}
              className={`${FIELD} w-[220px] font-mono`}
            />
          ) : (
            <span className="text-[17px] font-semibold text-fleet-text">
              {roleTitle(role.name)}
            </span>
          )}
          <span className="shrink-0 rounded-full bg-fleet-surface-3 px-2 py-px text-[11px] text-fleet-text-muted">
            {SOURCE_LABEL[role?.source ?? 'project']}
          </span>
        </div>
        {role !== null && <FileName path={role.path} />}
      </div>
      {role !== null && (
        <button
          type="button"
          onClick={() => openCrewFile(role.path)}
          className={`${SECONDARY} shrink-0 whitespace-nowrap`}
        >
          Open file
        </button>
      )}
    </div>
  );
}

const STATUS_TONE = {
  error: 'text-red-600 dark:text-red-400',
  dirty: 'text-amber-600 dark:text-amber-400',
  clean: 'text-fleet-text-subtle'
};

function SaveBar(props: {
  status: string;
  tone: keyof typeof STATUS_TONE;
  canDiscard: boolean;
  canSave: boolean;
  onDiscard: () => void;
  onSave: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-t border-fleet-border pt-3">
      <span
        className={`min-w-0 flex-1 truncate text-xs ${STATUS_TONE[props.tone]}`}
        title={props.status}
      >
        {props.status}
      </span>
      <button
        type="button"
        disabled={!props.canDiscard}
        onClick={props.onDiscard}
        className={SECONDARY}
      >
        Discard
      </button>
      <button type="button" disabled={!props.canSave} onClick={props.onSave} className={PRIMARY}>
        Save
      </button>
    </div>
  );
}
