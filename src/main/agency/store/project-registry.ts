import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ProjectKind } from '../../../shared/agency-projects';
import { parseJsonAs } from '../../../shared/parse-json';

/** A member a workspace project holds: checked out, not left out, with its git identity. */
export type RegisteredMember = {
  name: string;
  path: string;
  repoId: string;
  gitCommonDir: string;
  remote: string | null;
  defaultBranch: string | null;
};

/** A workspace project as `projects` and `project_members` keep it. */
export type RegisteredProject = {
  id: string;
  root: string;
  kind: Exclude<ProjectKind, 'repo'>;
  name: string;
  leftOut: string[];
  /** In member order. */
  members: RegisteredMember[];
};

type ProjectRow = { id: string; root: string; kind: string; name: string; left_out_json: string };
type MemberRow = {
  name: string;
  path: string;
  repo_id: string;
  git_common_dir: string;
  remote: string | null;
  default_branch: string | null;
};

const Names = z.array(z.string());

/**
 * Workspace projects: which repositories belong to which project, so a member
 * checkout, or any worktree of it, finds the project's Admiral. A repository
 * is in at most one project. A one-repository project has no row: it is its
 * repository.
 */
export class ProjectRegistry {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number
  ) {}

  /** Write a project and its members in one go, replacing what it held before. */
  save(project: RegisteredProject): void {
    this.db.transaction(() => {
      const taken = this.db.prepare<[string, string], { project_id: string }>(
        'SELECT project_id FROM project_members WHERE repo_id = ? AND project_id != ?'
      );
      for (const m of project.members) {
        const other = taken.get(m.repoId, project.id);
        if (other) {
          const owner = this.byId(other.project_id)?.name ?? other.project_id;
          throw new Error(`${m.name} already belongs to the project ${owner}.`);
        }
      }
      this.db
        .prepare(
          `INSERT INTO projects (id, root, kind, name, created_at, left_out_json) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root = excluded.root, kind = excluded.kind,
             name = excluded.name, left_out_json = excluded.left_out_json`
        )
        .run(
          project.id,
          project.root,
          project.kind,
          project.name,
          this.now(),
          JSON.stringify(project.leftOut)
        );
      this.db.prepare('DELETE FROM project_members WHERE project_id = ?').run(project.id);
      const insert = this.db.prepare(
        `INSERT INTO project_members
           (project_id, name, path, repo_id, git_common_dir, remote, default_branch, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      project.members.forEach((m, position) =>
        insert.run(
          project.id,
          m.name,
          m.path,
          m.repoId,
          m.gitCommonDir,
          m.remote,
          m.defaultBranch,
          position
        )
      );
    })();
  }

  byId(id: string): RegisteredProject | null {
    const row = this.db
      .prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?')
      .get(id);
    return row ? this.toProject(row) : null;
  }

  /** The workspace project a member repository belongs to. */
  ofRepo(repoId: string): RegisteredProject | null {
    const row = this.db
      .prepare<
        [string],
        { project_id: string }
      >('SELECT project_id FROM project_members WHERE repo_id = ?')
      .get(repoId);
    return row ? this.byId(row.project_id) : null;
  }

  /** The folder project at `root` or holding it, for a folder that is not itself a repository. */
  holdingFolder(path: string): RegisteredProject | null {
    const rows = this.db
      .prepare<[], ProjectRow>("SELECT * FROM projects WHERE kind = 'folder'")
      .all();
    const row = rows
      .filter((r) => path === r.root || path.startsWith(`${r.root}/`))
      .sort((a, b) => b.root.length - a.root.length)
      .at(0);
    return row ? this.toProject(row) : null;
  }

  private toProject(row: ProjectRow): RegisteredProject {
    const members = this.db
      .prepare<
        [string],
        MemberRow
      >('SELECT * FROM project_members WHERE project_id = ? ORDER BY position')
      .all(row.id);
    return {
      id: row.id,
      root: row.root,
      kind: row.kind === 'folder' ? 'folder' : 'submodules',
      name: row.name,
      leftOut: parseJsonAs(Names, row.left_out_json) ?? [],
      members: members.map((m) => ({
        name: m.name,
        path: m.path,
        repoId: m.repo_id,
        gitCommonDir: m.git_common_dir,
        remote: m.remote,
        defaultBranch: m.default_branch
      }))
    };
  }
}
