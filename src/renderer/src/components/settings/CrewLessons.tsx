import { useCallback, useEffect, useState } from 'react';
import { jobDisplayId } from '../../../../shared/agency';
import type { AppliedCrewLesson } from '../../../../shared/agency-lessons';
import { LessonChange } from '../admiral/LessonChange';

const UNDO =
  'shrink-0 rounded border border-fleet-border-strong px-2 py-1 text-xs text-fleet-text-secondary transition hover:bg-fleet-surface-3 hover:text-fleet-text active:scale-[0.97] focus-ring disabled:opacity-50';

/**
 * The crew lessons Fleet wrote into a project's roles, newest first, each
 * with Undo. Undo refuses, with the reason, once the client has edited that
 * part of the role since.
 */
export function CrewLessons({ repoId }: { repoId: string }): React.JSX.Element | null {
  const [lessons, setLessons] = useState<AppliedCrewLesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLessons(await window.fleet.agency.projects.crewLessons(repoId));
  }, [repoId]);

  useEffect(() => {
    void load();
  }, [load]);

  const undo = async (id: number): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.fleet.agency.projects.undoCrewLesson(id);
      setError(result.ok ? null : result.reason);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (lessons === null || lessons.length === 0) return null;
  return <LessonList lessons={lessons} error={error} busy={busy} onUndo={(id) => void undo(id)} />;
}

export function LessonList(props: {
  lessons: AppliedCrewLesson[];
  error: string | null;
  busy: boolean;
  onUndo: (id: number) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-fleet-text-secondary">Crew lessons</h4>
      <ul className="divide-y divide-fleet-border rounded border border-fleet-border">
        {props.lessons.map((lesson) => (
          <LessonRow key={lesson.id} lesson={lesson} busy={props.busy} onUndo={props.onUndo} />
        ))}
      </ul>
      {props.error !== null && (
        <p className="text-xs text-red-500 dark:text-red-400">{props.error}</p>
      )}
    </div>
  );
}

/** One lesson: what it says, where it was learned, the change to the role, and Undo. */
function LessonRow(props: {
  lesson: AppliedCrewLesson;
  busy: boolean;
  onUndo: (id: number) => void;
}): React.JSX.Element {
  const { lesson } = props;
  const undone = lesson.undoneAt !== null;
  return (
    <li className={`flex flex-col gap-1.5 px-3 py-2 ${undone ? 'opacity-55' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={`text-sm text-fleet-text ${undone ? 'line-through' : ''}`}>
            {lesson.lesson}
          </span>
          <span className="text-xs text-fleet-text-subtle">
            {lesson.role} role · {lesson.cue} · Learned on {jobDisplayId(lesson.jobId)}
          </span>
        </span>
        {undone ? (
          <span className="shrink-0 py-1 text-xs text-fleet-text-subtle">Undone</span>
        ) : (
          <button
            type="button"
            disabled={props.busy}
            onClick={() => props.onUndo(lesson.id)}
            className={UNDO}
          >
            Undo
          </button>
        )}
      </div>
      {!undone && <LessonChange lesson={lesson} />}
    </li>
  );
}
