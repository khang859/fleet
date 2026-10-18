import { useEffect, useState } from 'react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import {
  READ_SOURCE_COPY,
  type ReadProposal,
  type ReadSource,
  type ReadSourceId
} from '../../../../shared/agency-understanding';
import { AdmiralSays, OnboardingButton, SectionLabel } from './onboarding-ui';

/** What the client did with a proposed line: saved it, or said it is not them. */
export type LineChoice = 'kept' | 'dropped';

/**
 * Read your work: the client ticks what the Admiral may read, Fleet reads it
 * once through the Admiral's model, and the client keeps or drops each line
 * it took. A kept line is saved at once; a dropped or untouched one never is.
 */
export function ReadYourWork({
  repo,
  wide,
  doneLabel,
  onKept,
  onDone
}: {
  repo: AgencyRepoRef;
  /** Room for the lines beside the sources rather than under them. */
  wide: boolean;
  /** What the last button says before and after a read. */
  doneLabel: { before: string; after: string };
  onKept?: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const work = useReadWork(repo, onKept);
  const { lines, choices, reading, saving } = work;
  const open = (lines ?? []).flatMap((_, i) => (choices.has(i) ? [] : [i]));

  return (
    <div className={`flex gap-7 ${wide ? 'flex-row items-start' : 'flex-col'}`}>
      <section className="flex min-w-0 flex-1 flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[15px] font-medium text-fleet-text">Can I read some of your work?</h2>
          <p className="text-[13px] leading-relaxed text-fleet-text-secondary">
            I learn faster from what you did than from questions. Tick what I may read. Fleet masks
            secrets in it and sends it once to my model. Then I show you what I took from it.
          </p>
        </div>
        <ReadSources
          sources={work.sources}
          ticked={work.ticked}
          disabled={reading}
          onToggle={work.toggle}
        />
        <p className="text-xs leading-relaxed text-fleet-text-subtle">
          Never read: your Claude login, env files, keys, or code.
        </p>
        <div className="flex">
          <OnboardingButton
            kind={lines === null ? 'primary' : 'secondary'}
            disabled={reading || work.ticked.size === 0}
            onClick={() => void work.read()}
          >
            {reading ? 'Reading…' : lines === null ? 'Read what I ticked' : 'Read again'}
          </OnboardingButton>
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <ReadFound lines={lines} reading={reading}>
          <ReadLines
            lines={lines ?? []}
            choices={choices}
            disabled={saving}
            onChoose={work.choose}
          />
        </ReadFound>
        {work.error !== null && (
          <p className="text-xs text-red-500 dark:text-red-400">{work.error}</p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          {open.length > 0 && (
            <OnboardingButton disabled={saving} onClick={() => void work.keep(open)}>
              Keep all
            </OnboardingButton>
          )}
          <OnboardingButton
            kind={lines === null ? 'secondary' : 'primary'}
            disabled={saving || reading}
            onClick={onDone}
          >
            {lines === null ? doneLabel.before : doneLabel.after}
          </OnboardingButton>
        </div>
      </section>
    </div>
  );
}

/** The heading over the proposed lines, and what shows before a read or after an empty one. */
function ReadFound(props: {
  lines: ReadProposal[] | null;
  reading: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { lines } = props;
  const found = lines !== null && lines.length > 0;
  return (
    <>
      <SectionLabel note={found ? `${lines.length} found · keep the ones that are you` : undefined}>
        WHAT I TOOK FROM IT
      </SectionLabel>
      {lines === null ? (
        <p className="rounded-lg border border-dashed border-fleet-border px-3 py-4 text-center text-xs text-fleet-text-subtle">
          {props.reading ? 'Reading your work…' : 'Nothing read yet.'}
        </p>
      ) : found ? (
        props.children
      ) : (
        <AdmiralSays>I found nothing new. What I read says what I know already.</AdmiralSays>
      )}
    </>
  );
}

type ReadWork = {
  sources: ReadSource[] | null;
  ticked: ReadonlySet<ReadSourceId>;
  /** Null until a read comes back. */
  lines: ReadProposal[] | null;
  choices: ReadonlyMap<number, LineChoice>;
  reading: boolean;
  saving: boolean;
  error: string | null;
  read: () => Promise<void>;
  keep: (indexes: number[]) => Promise<void>;
  choose: (index: number, choice: LineChoice | null) => void;
  toggle: (id: ReadSourceId) => void;
};

/** The sources and ticks, the one read, and the client's choice on each line it proposed. */
function useReadWork(repo: AgencyRepoRef, onKept: (() => void) | undefined): ReadWork {
  const [sources, setSources] = useState<ReadSource[] | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<ReadSourceId>>(new Set());
  const [lines, setLines] = useState<ReadProposal[] | null>(null);
  const [choices, setChoices] = useState<ReadonlyMap<number, LineChoice>>(new Map());
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyed on the repository's fields, not the object, which a redraw replaces with an equal copy.
  const { repoId, root, name } = repo;
  useEffect(() => {
    let live = true;
    void window.fleet.agency.projects
      .readSources({ repoId, root, name })
      .then((list) => {
        if (!live) return;
        setSources(list);
        setTicked(new Set(list.filter((s) => s.available).map((s) => s.id)));
      })
      .catch((err: unknown) => live && setError(String(err)));
    return () => {
      live = false;
    };
  }, [repoId, root, name]);

  /** Run one call with its busy flag, showing why it was refused or how it failed. */
  const attempt = async (
    setBusy: (busy: boolean) => void,
    call: () => Promise<string | null>
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setError(await call());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const read = async (): Promise<void> =>
    attempt(setReading, async () => {
      const result = await window.fleet.agency.projects.readWork({
        repo: { repoId, root, name },
        sources: [...ticked]
      });
      if (!result.ok) return result.reason;
      setLines(result.lines);
      setChoices(new Map());
      return null;
    });

  const keep = async (indexes: number[]): Promise<void> =>
    attempt(setSaving, async () => {
      const result = await window.fleet.agency.projects.keepRead({
        repo: { repoId, root, name },
        lines: indexes.map((i) => (lines ?? [])[i])
      });
      if (!result.ok) return result.reason;
      setChoices(new Map([...choices, ...indexes.map((i): [number, LineChoice] => [i, 'kept'])]));
      onKept?.();
      return null;
    });

  const choose = (index: number, choice: LineChoice | null): void => {
    if (choice === 'kept') {
      void keep([index]);
      return;
    }
    const next = new Map(choices);
    if (choice === null) next.delete(index);
    else next.set(index, choice);
    setChoices(next);
  };

  const toggle = (id: ReadSourceId): void => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };

  return { sources, ticked, lines, choices, reading, saving, error, read, keep, choose, toggle };
}

/** The sources to tick, each with what it reads, or why it cannot be read here. */
export function ReadSources(props: {
  sources: ReadSource[] | null;
  ticked: ReadonlySet<ReadSourceId>;
  disabled: boolean;
  onToggle: (id: ReadSourceId) => void;
}): React.JSX.Element {
  if (props.sources === null) {
    return <p className="text-xs text-fleet-text-subtle">Looking at what there is to read…</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {props.sources.map((s) => {
        const copy = READ_SOURCE_COPY[s.id];
        return (
          <li key={s.id}>
            <label
              className={`flex items-start gap-3 rounded-lg border border-fleet-border bg-fleet-surface px-3 py-2.5 ${
                s.available ? 'cursor-pointer' : 'opacity-60'
              }`}
            >
              <input
                type="checkbox"
                checked={s.available && props.ticked.has(s.id)}
                disabled={!s.available || props.disabled}
                onChange={() => props.onToggle(s.id)}
                className="fleet-accent-input mt-0.5 shrink-0"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-fleet-text">{copy.label}</span>
                <span className="text-xs text-fleet-text-muted">{copy.hint}</span>
                <span className="truncate text-[11px] text-fleet-text-subtle" title={s.detail}>
                  {s.detail}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

const LAYER_LABEL: Record<ReadProposal['layer'], string> = {
  you: 'You',
  project: 'This project'
};

/** The lines the read proposed, each with its evidence and Keep or Not me. */
export function ReadLines(props: {
  lines: ReadProposal[];
  choices: ReadonlyMap<number, LineChoice>;
  disabled: boolean;
  onChoose: (index: number, choice: LineChoice | null) => void;
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1.5">
      {props.lines.map((line, i) => {
        const choice = props.choices.get(i);
        const dropped = choice === 'dropped';
        return (
          <li
            key={i}
            className={`flex flex-wrap items-center gap-3 rounded-lg border border-fleet-border bg-fleet-surface px-3 py-2.5 ${
              dropped ? 'opacity-55' : ''
            }`}
          >
            <span className="flex min-w-[220px] flex-1 flex-col gap-0.5">
              <span className={`text-[13px] text-fleet-text ${dropped ? 'line-through' : ''}`}>
                {line.text}
              </span>
              <span className="text-[11px] text-fleet-text-subtle">
                {dropped
                  ? 'Dropped · not saved'
                  : `From ${line.source}: ${line.evidence} · ${LAYER_LABEL[line.layer]}`}
              </span>
              {line.clash !== null && !dropped && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">
                  Clashes with {line.clash.source}: &ldquo;{line.clash.rule}&rdquo; If you keep it,
                  you pick which one wins.
                </span>
              )}
            </span>
            <span className="flex shrink-0 gap-1.5">
              {choice === 'kept' ? (
                <span className="rounded-md border border-green-500/50 bg-green-500/10 px-2.5 py-1.5 text-xs text-green-700 dark:text-green-400">
                  Kept
                </span>
              ) : dropped ? (
                <OnboardingButton disabled={props.disabled} onClick={() => props.onChoose(i, null)}>
                  Undo
                </OnboardingButton>
              ) : (
                <>
                  <OnboardingButton
                    kind="primary"
                    disabled={props.disabled}
                    aria-label={`Keep "${line.text}"`}
                    onClick={() => props.onChoose(i, 'kept')}
                  >
                    Keep
                  </OnboardingButton>
                  <OnboardingButton
                    disabled={props.disabled}
                    aria-label={`Not me: "${line.text}"`}
                    onClick={() => props.onChoose(i, 'dropped')}
                  >
                    Not me
                  </OnboardingButton>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
