import type Database from 'better-sqlite3';
import type { AppliedCrewLesson } from '../../../shared/agency-lessons';

/** A crew lesson as written, with what Undo needs to take it out again. */
export type CrewLessonRecord = AppliedCrewLesson & {
  projectId: string;
  /** The project's role file the lesson was written to. */
  path: string;
  /** Whether the lesson made that file, as a copy of a bundled or user role. */
  createdCopy: boolean;
};

type Row = {
  id: number;
  project_id: string;
  job_id: number;
  role: string;
  cue: string;
  lesson: string;
  replace_text: string | null;
  with_text: string;
  path: string;
  created_copy: number;
  applied_at: number;
  undone_at: number | null;
};

const toRecord = (row: Row): CrewLessonRecord => ({
  id: row.id,
  projectId: row.project_id,
  jobId: row.job_id,
  role: row.role,
  cue: row.cue,
  lesson: row.lesson,
  replace: row.replace_text,
  with: row.with_text,
  path: row.path,
  createdCopy: row.created_copy === 1,
  appliedAt: row.applied_at,
  undoneAt: row.undone_at
});

/** The crew lessons Fleet wrote into a project's roles, newest first. */
export class LessonStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  record(input: Omit<CrewLessonRecord, 'id' | 'appliedAt' | 'undoneAt'>): CrewLessonRecord {
    const row = this.db
      .prepare<unknown[], Row>(
        `INSERT INTO crew_lessons
           (project_id, job_id, role, cue, lesson, replace_text, with_text, path, created_copy, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        input.projectId,
        input.jobId,
        input.role,
        input.cue,
        input.lesson,
        input.replace,
        input.with,
        input.path,
        input.createdCopy ? 1 : 0,
        this.now()
      );
    if (row === undefined) throw new Error('crew lesson not recorded');
    return toRecord(row);
  }

  get(id: number): CrewLessonRecord | null {
    const row = this.db.prepare<[number], Row>('SELECT * FROM crew_lessons WHERE id = ?').get(id);
    return row === undefined ? null : toRecord(row);
  }

  list(projectId: string): CrewLessonRecord[] {
    return this.db
      .prepare<
        [string],
        Row
      >('SELECT * FROM crew_lessons WHERE project_id = ? ORDER BY applied_at DESC, id DESC')
      .all(projectId)
      .map(toRecord);
  }

  markUndone(id: number): void {
    this.db.prepare('UPDATE crew_lessons SET undone_at = ? WHERE id = ?').run(this.now(), id);
  }
}
