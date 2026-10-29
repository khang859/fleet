import { z } from 'zod';
import { answerJson } from './agency-understanding';

/**
 * A crew lesson: after a job ends, Fleet asks the Admiral's model once for at
 * most one change to a role the job's crew ran with. The change is one text
 * replacement in the role's instructions, written at once to the project's
 * copy of the role. The client sees it in What the Admiral knows, with Undo.
 */
export type AppliedCrewLesson = {
  id: number;
  /** The job the lesson was learned on. */
  jobId: number;
  role: string;
  /** When the lesson applies, in a few words. */
  cue: string;
  /** The lesson, as one sentence. */
  lesson: string;
  /** Text of the role it replaced word for word, or null when `with` was added as a new paragraph. */
  replace: string | null;
  with: string;
  appliedAt: number;
  undoneAt: number | null;
};

/** What Undo on a crew lesson did: refused with a reason the client reads. */
export type CrewLessonUndo = { ok: true } | { ok: false; reason: string };

/** The most a lesson may grow a role by, so roles stay short. */
export const LESSON_GROWTH_MAX_CHARS = 600;

const LESSON_FIELD_MAX = 400;

/** The topic an undone lesson is remembered by, so the same one is not proposed again. */
export const lessonTopic = (role: string, cue: string): string =>
  `crew-lesson:${role}:${cue.trim().toLowerCase().replace(/\s+/g, ' ')}`;

/** The role's instructions with the lesson in, or null when the text it replaces is not there once. */
export function applyLesson(
  instructions: string,
  edit: Pick<AppliedCrewLesson, 'replace' | 'with'>
): string | null {
  const body = instructions.trim();
  const text = edit.with.trim();
  if (edit.replace === null) return `${body}\n\n${text}`;
  return swapOnce(body, edit.replace, text);
}

/**
 * The role's instructions with the lesson taken out again, or null when the
 * text it wrote is not there once, as the client edited that part since.
 */
export function undoLesson(
  instructions: string,
  edit: Pick<AppliedCrewLesson, 'replace' | 'with'>
): string | null {
  const body = instructions.trim();
  const text = edit.with.trim();
  return edit.replace === null
    ? swapOnce(body, `\n\n${text}`, '')
    : swapOnce(body, text, edit.replace);
}

/** `body` with the one `from` in it swapped for `to`, or null when `from` is not there exactly once. */
function swapOnce(body: string, from: string, to: string): string | null {
  const at = body.indexOf(from);
  if (from === '' || at < 0 || body.includes(from, at + 1)) return null;
  return `${body.slice(0, at)}${to}${body.slice(at + from.length)}`.trim();
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
