import { z } from 'zod';
import type { CrewSource } from './agency-crew';
import { answerJson } from './agency-understanding';

/**
 * A crew lesson: after a job ends, Fleet asks the Admiral's model once for at
 * most one change to a role the job's crew ran with. The change is one text
 * replacement in the role's instructions, which the client approves on a
 * `crew_lesson` card before any file is written.
 */
export type CrewLesson = {
  /** The job the lesson was learned on. */
  jobId: number;
  role: string;
  /** Where the role came from when the card went up, which decides the card's options. */
  source: CrewSource;
  /** When the lesson applies, in a few words. */
  cue: string;
  /** The lesson, as one sentence. */
  lesson: string;
  /** What in the job's record shows it. */
  evidence: string;
  /** Text of the role it replaces word for word, or null to add `with` as a new paragraph. */
  replace: string | null;
  with: string;
};

/** The most a lesson may grow a role by, so roles stay short. */
export const LESSON_GROWTH_MAX_CHARS = 600;

const LESSON_FIELD_MAX = 400;

/** What a lesson card's pick does: write a role file, or turn the lesson down. */
export type LessonPick = 'own' | 'project' | 'user' | 'decline';

/** A lesson card's options, in order, for a role from `source`. */
export function lessonOptions(
  source: CrewSource
): Array<{ pick: LessonPick; label: string; detail: string }> {
  if (source === 'project') {
    return [
      { pick: 'own', label: 'Change it', detail: "Changes this project's role." },
      {
        pick: 'decline',
        label: 'Not now',
        detail: 'Changes nothing, and Fleet does not ask again.'
      }
    ];
  }
  return [
    {
      pick: 'project',
      label: 'This project',
      detail: 'Saves a copy of the role for this project.'
    },
    {
      pick: 'user',
      label: 'All projects',
      detail:
        source === 'bundled'
          ? 'Saves your own copy of the role, used by every project.'
          : 'Changes your role, used by every project.'
    },
    { pick: 'decline', label: 'Not now', detail: 'Changes nothing, and Fleet does not ask again.' }
  ];
}

/** What picking `option` on a card for `lesson` does, or null for an option it does not have. */
export function lessonPick(lesson: CrewLesson, option: number | undefined): LessonPick | null {
  return option === undefined ? null : (lessonOptions(lesson.source)[option]?.pick ?? null);
}

/** The topic a turned-down lesson is remembered by, so the same one is not proposed again. */
export const lessonTopic = (role: string, cue: string): string =>
  `crew-lesson:${role}:${cue.trim().toLowerCase().replace(/\s+/g, ' ')}`;

/** The role's instructions with the lesson in, or null when the text it replaces is not there once. */
export function applyLesson(
  instructions: string,
  edit: Pick<CrewLesson, 'replace' | 'with'>
): string | null {
  const body = instructions.trim();
  const text = edit.with.trim();
  if (edit.replace === null) return `${body}\n\n${text}`;
  const at = body.indexOf(edit.replace);
  if (edit.replace === '' || at < 0 || body.includes(edit.replace, at + 1)) return null;
  return `${body.slice(0, at)}${text}${body.slice(at + edit.replace.length)}`.trim();
}

const Field = z.string().trim().min(1).max(LESSON_FIELD_MAX);

export const LessonAnswer = z.object({
  role: z.string().trim().min(1),
  cue: Field,
  lesson: Field,
  evidence: Field,
  replace: z.string().nullable(),
  with: z.string().trim().min(1)
});

export type LessonAnswer = z.output<typeof LessonAnswer>;

/**
 * The model's answer: a lesson, null for none, or a reason it cannot be read.
 * Thinking, a fence or words around the object are allowed.
 */
export function parseLesson(
  text: string
): { ok: true; lesson: LessonAnswer | null } | { ok: false; reason: string } {
  const parsed = z.object({ lesson: z.unknown() }).safeParse(answerJson(text, 'lesson'));
  if (!parsed.success) return { ok: false, reason: 'the answer is not the JSON asked for.' };
  if (parsed.data.lesson === null) return { ok: true, lesson: null };
  const lesson = LessonAnswer.safeParse(parsed.data.lesson);
  if (!lesson.success) {
    const issue = lesson.error.issues[0];
    return {
      ok: false,
      reason: `"lesson.${issue.path.join('.')}" ${issue.message}.`
    };
  }
  return { ok: true, lesson: lesson.data };
}
