import { useCallback, useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  YOU_LAYER,
  clientEntryList,
  normText,
  sourceLabel,
  type ClientEntry,
  type PreferenceConflict
} from '../../../../shared/agency-client-file';
import type {
  AgencyProjectSummary,
  ClientFileView,
  ClientLineChange,
  ClientLineResult
} from '../../../../shared/agency-projects';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { useSettingsNavStore } from '../../store/settings-nav-store';
import { ReadYourWork } from '../admiral/ReadYourWork';
import { ClientFileEditor } from './ClientFileEditor';
import { OutsideChange } from './OutsideChange';
import { TrustPicker } from './TrustPicker';

const FIELD =
  'min-w-0 rounded border border-fleet-border-strong bg-fleet-surface-3 px-2 py-1 text-sm text-fleet-text';
const ICON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded text-fleet-text-subtle transition hover:bg-fleet-surface-3 hover:text-fleet-text focus-ring disabled:pointer-events-none disabled:opacity-40';

const SETTLE =
  'rounded border border-fleet-border-strong px-2 py-1 text-xs text-fleet-text-secondary transition hover:bg-fleet-surface-3 hover:text-fleet-text active:scale-[0.97] focus-ring disabled:opacity-50';

/** The line being edited, or the new line being typed when `index` is null. */
export type LineDraft = { index: number | null; text: string };

/**
 * Settings › Agency › Admiral › What the Admiral knows: the client's
 * preferences, as the Admiral reads them at the start of every job. The You
 * tab holds what goes for every project; each project's tab holds what goes
 * for it alone, and wins where the two disagree.
 */
export function AdmiralKnows(): React.JSX.Element {
  const [projects, setProjects] = useState<AgencyProjectSummary[] | null>(null);
  const [layer, setLayer] = useState<string>(YOU_LAYER);
  const [file, setFile] = useState<ClientFileView | null>(null);
  const [asText, setAsText] = useState(false);
  const [draft, setDraft] = useState<LineDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.fleet.agency.projects.list().then((list) => {
      setProjects(list);
      const asked = useSettingsNavStore.getState().clientFileRepoId;
      if (list.some((p) => p.repo.repoId === asked) && asked !== null) setLayer(asked);
    });
  }, []);

  const load = useCallback(async (id: string): Promise<void> => {
    setFile(await window.fleet.agency.projects.clientFile(id));
  }, []);

  useEffect(() => {
    setFile(null);
    setDraft(null);
    setError(null);
    setAsText(false);
    void load(layer);
  }, [layer, load]);

  const project = projects?.find((p) => p.repo.repoId === layer)?.repo ?? null;
  const name = layer === YOU_LAYER ? 'You' : (project?.name ?? 'Project');

  /** Run one change to the layer, show why it was refused, and read the file again. */
  const act = async (call: () => Promise<ClientLineResult>): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await call();
      setError(result.ok ? null : result.reason);
      await load(layer);
      return result.ok;
    } finally {
      setBusy(false);
    }
  };

  const change = async (c: ClientLineChange): Promise<void> => {
    if (await act(async () => window.fleet.agency.projects.changeClientLine({ layer, change: c })))
      setDraft(null);
  };

  const settle = async (id: number, winner: 'line' | 'rule'): Promise<boolean> =>
    act(async () =>
      window.fleet.agency.projects.settleConflict({ repoId: layer, layer, id, winner })
    );

  /** Keep or undo the layer's outside change, then read the file again. */
  const settleOutside = async (call: (layer: string) => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await call(layer);
      await load(layer);
    } finally {
      setBusy(false);
    }
  };

  const entries = clientEntryList(file?.text ?? null);
  const saveDraft = (): void => {
    if (draft !== null && draft.text.trim() !== '') void change(draftChange(draft, entries, name));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-fleet-text">What the Admiral knows</h3>
        <p className="text-xs text-fleet-text-subtle">
          How you like the work. The Admiral reads this at the start of every job, and adds a line
          only when you say yes. A project&apos;s lines win over yours where they disagree.
        </p>
      </div>

      <LayerTabs projects={projects ?? []} layer={layer} onLayer={setLayer} />

      {layer !== YOU_LAYER && <TrustPicker repoId={layer} />}

      {project !== null && (
        <ReadMyWork key={project.repoId} repo={project} onKept={() => void load(layer)} />
      )}

      {file?.changedOutside === true && (
        <OutsideChange
          text="This file changed outside Fleet. The Admiral works from the version Fleet last wrote until you keep the change."
          busy={busy}
          onKeep={() => void settleOutside(window.fleet.agency.projects.keepClientFile)}
          onUndo={() => void settleOutside(window.fleet.agency.projects.undoClientFile)}
        />
      )}

      {file === null ? null : asText ? (
        <ClientFileEditor
          layer={layer}
          file={file}
          placeholder={`# ${name}\n- Open PRs as drafts.`}
          onSaved={async () => {
            await load(layer);
            setAsText(false);
          }}
          onCancel={() => setAsText(false)}
        />
      ) : (
        <>
          <PreferenceLines
            entries={entries}
            uses={file.uses}
            conflicts={file.conflicts}
            draft={draft}
            disabled={busy || file.changedOutside}
            onDraft={setDraft}
            onSave={saveDraft}
            onRemove={(index) => void change({ kind: 'remove', index, was: entries[index].text })}
            onSettle={(id, winner) => void settle(id, winner)}
          />
          {error !== null && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          <LineActions
            path={file.path}
            canAdd={!busy && !file.changedOutside && draft === null}
            onAdd={() => setDraft({ index: null, text: '' })}
            onText={() => {
              setDraft(null);
              setAsText(true);
            }}
          />
        </>
      )}
    </div>
  );
}

/** The change a typed line makes: a new line, or an edit of the line it replaces. */
function draftChange(draft: LineDraft, entries: ClientEntry[], name: string): ClientLineChange {
  return draft.index === null
    ? { kind: 'add', name, text: draft.text }
    : { kind: 'edit', index: draft.index, was: entries[draft.index].text, text: draft.text };
}

function LineActions(props: {
  path: string;
  canAdd: boolean;
  onAdd: () => void;
  onText: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={!props.canAdd}
        onClick={props.onAdd}
        className="flex items-center gap-1 rounded bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text transition active:scale-[0.97] disabled:text-fleet-text-subtle disabled:active:scale-100"
      >
        <Plus size={12} />
        Add a line
      </button>
      <span
        className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-fleet-text-subtle"
        title={props.path}
      >
        {props.path}
      </span>
      <button
        type="button"
        onClick={props.onText}
        className="shrink-0 text-xs text-fleet-text-muted hover:text-fleet-text focus-ring"
      >
        Edit as text
      </button>
    </div>
  );
}

/** A project's way into Read your work, and the read itself once opened. */
function ReadMyWork(props: { repo: AgencyRepoRef; onKept: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex-1 text-xs text-fleet-text-subtle">
          The Admiral can learn more from your commits, reviews and past jobs here.
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text transition active:scale-[0.97] focus-ring"
        >
          Read my work
        </button>
      </div>
    );
  }
  return (
    <div className="rounded border border-fleet-border p-3">
      <ReadYourWork
        repo={props.repo}
        wide={false}
        doneLabel={{ before: 'Close', after: 'Done' }}
        onKept={props.onKept}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

function LayerTabs(props: {
  projects: AgencyProjectSummary[];
  layer: string;
  onLayer: (layer: string) => void;
}): React.JSX.Element {
  const tabs = [
    { id: YOU_LAYER, label: 'You · every project' },
    ...props.projects.map((p) => ({ id: p.repo.repoId, label: p.repo.name }))
  ];
  return (
    <div role="tablist" aria-label="Whose preferences" className="flex flex-wrap gap-1">
      {tabs.map((t) => {
        const on = props.layer === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => props.onLayer(t.id)}
            className={`rounded px-2.5 py-1 text-sm transition-colors focus-ring ${
              on
                ? 'bg-fleet-surface-3 font-medium text-fleet-text'
                : 'text-fleet-text-muted hover:bg-fleet-surface-3/60 hover:text-fleet-text'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** A layer's lines, each with where it came from, to edit or remove one at a time. */
export function PreferenceLines(props: {
  entries: ClientEntry[];
  /** How many jobs used each line, by its normal form. */
  uses: Record<string, number>;
  /** The layer's clashes with the project's rule files, open or settled. */
  conflicts: PreferenceConflict[];
  draft: LineDraft | null;
  disabled: boolean;
  onDraft: (draft: LineDraft | null) => void;
  onSave: () => void;
  onRemove: (index: number) => void;
  onSettle: (id: number, winner: 'line' | 'rule') => void;
}): React.JSX.Element {
  const { entries, draft } = props;
  const conflictOf = (text: string): PreferenceConflict | undefined =>
    props.conflicts.find((c) => c.normText === normText(text) && c.status !== 'rule');
  if (entries.length === 0 && draft === null) {
    return (
      <p className="rounded border border-dashed border-fleet-border px-3 py-4 text-center text-xs text-fleet-text-subtle">
        Nothing yet. Add a line, or answer the Admiral when it asks to remember something.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-fleet-border rounded border border-fleet-border">
      {entries.map((entry, index) => {
        if (draft?.index === index) return <DraftRow key={index} {...props} draft={draft} />;
        const conflict = conflictOf(entry.text);
        if (conflict?.status === 'open') {
          return (
            <ConflictRow
              key={index}
              text={entry.text}
              conflict={conflict}
              disabled={props.disabled}
              onSettle={props.onSettle}
            />
          );
        }
        return (
          <LineRow
            key={index}
            entry={entry}
            wonOver={conflict?.ruleSource ?? null}
            uses={props.uses[normText(entry.text)] ?? 0}
            locked={props.disabled || draft !== null}
            onEdit={() => props.onDraft({ index, text: entry.text })}
            onRemove={() => props.onRemove(index)}
          />
        );
      })}
      {draft?.index === null && <DraftRow {...props} draft={draft} />}
    </ul>
  );
}

/** One saved line: its source, how many jobs used it, and buttons to edit or remove it. */
function LineRow(props: {
  entry: ClientEntry;
  /** The rule file this line won over, when it clashed with one. */
  wonOver: string | null;
  uses: number;
  locked: boolean;
  onEdit: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { entry } = props;
  return (
    <li className="flex items-center gap-3 py-1.5 pl-3 pr-1.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-fleet-text">{entry.text}</span>
        {props.wonOver !== null && (
          <span className="text-xs text-fleet-text-subtle">Wins over {props.wonOver}</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-fleet-text-subtle">{sourceLabel(entry.source)}</span>
      <UseCount n={props.uses} />
      <span className="flex shrink-0">
        <button
          type="button"
          aria-label={`Edit "${entry.text}"`}
          disabled={props.locked}
          onClick={props.onEdit}
          className={ICON}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          aria-label={`Remove "${entry.text}"`}
          disabled={props.locked}
          onClick={props.onRemove}
          className={ICON}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </li>
  );
}

/** A line that clashes with a project rule, until the client picks which one wins. */
function ConflictRow(props: {
  text: string;
  conflict: PreferenceConflict;
  disabled: boolean;
  onSettle: (id: number, winner: 'line' | 'rule') => void;
}): React.JSX.Element {
  const { conflict } = props;
  return (
    <li className="flex flex-wrap items-center gap-3 bg-amber-400/5 py-2 pl-3 pr-1.5">
      <span className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <span className="text-sm text-fleet-text">{props.text}</span>
        <span className="text-xs text-amber-700 dark:text-amber-400/90">
          Clashes with {conflict.ruleSource}: &ldquo;{conflict.ruleText}&rdquo; Which one wins?
        </span>
      </span>
      <span className="flex shrink-0 gap-1.5">
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onSettle(conflict.id, 'line')}
          className={SETTLE}
        >
          Keep this line
        </button>
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => props.onSettle(conflict.id, 'rule')}
          className={SETTLE}
        >
          {conflict.ruleSource} wins
        </button>
      </span>
    </li>
  );
}

function UseCount({ n }: { n: number }): React.JSX.Element | null {
  if (n === 0) return null;
  return (
    <span className="shrink-0 text-xs text-fleet-text-subtle">
      used {n === 1 ? '1 time' : `${n} times`}
    </span>
  );
}

function DraftRow(props: {
  draft: LineDraft;
  disabled: boolean;
  onDraft: (draft: LineDraft | null) => void;
  onSave: () => void;
}): React.JSX.Element {
  const { draft } = props;
  return (
    <li className="flex items-center gap-1.5 py-1.5 pl-1.5 pr-1.5">
      <input
        aria-label={draft.index === null ? 'New line' : 'Edit line'}
        autoFocus
        value={draft.text}
        placeholder="e.g. Open PRs as drafts."
        onChange={(e) => props.onDraft({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSave();
          if (e.key === 'Escape') props.onDraft(null);
        }}
        className={`${FIELD} flex-1`}
      />
      <button
        type="button"
        aria-label="Save line"
        disabled={props.disabled || draft.text.trim() === ''}
        onClick={props.onSave}
        className={ICON}
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => props.onDraft(null)}
        className={ICON}
      >
        <X size={14} />
      </button>
    </li>
  );
}
