import type { CrewLesson } from '../../../../shared/agency-lessons';
import { Line } from './ClientFileViews';

/** What a crew lesson card would change in its role: the text it replaces struck out, then the new text. */
export function LessonChange({ lesson }: { lesson: CrewLesson }): React.JSX.Element {
  return (
    <ul
      aria-label={`Changes to the ${lesson.role} role`}
      className="flex flex-col gap-1 rounded border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs leading-snug whitespace-pre-wrap"
    >
      {lesson.replace !== null && <Line sign="remove" text={lesson.replace} />}
      <Line sign="add" text={lesson.with} />
    </ul>
  );
}
