import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  findWorkflow,
  otherScope,
  type MoveWorkflowRequest,
  type MoveWorkflowResult,
  type SaveWorkflowRequest,
  type SaveWorkflowResult,
  type WorkflowDef,
  type WorkflowEntry,
  type WorkflowScope
} from '../../shared/workflows';
import type { ApprovalStore, DisabledFiles } from './approval';
import {
  findWorkflowFiles,
  hashText,
  parseWorkflow,
  PROJECT_WORKFLOWS_DIR,
  readWorkflowFile,
  slugify,
  WorkflowFileError,
  type FoundFile
} from './config';
import { unsafeTarget } from './report';

const DRAFT_CHANGED =
  'A person changed this draft after you read it, so this save did nothing. ' +
  'Read it again with fleet_draft_read, make your change on what it says now, and save again.';

const DRAFT_REMOVED =
  'A person removed this draft, so this save did nothing. Do not save again. Tell the person.';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The workflow files of a project, and what a person may do with them. */
export class WorkflowCatalog {
  constructor(
    private readonly approvals: ApprovalStore,
    private readonly disabled: DisabledFiles,
    private readonly personalDir: string,
    /** Called after Fleet itself changes what `list` answers. */
    private readonly onChange: () => void = () => undefined
  ) {}

  list(projectPath: string): WorkflowEntry[] {
    return findWorkflowFiles(projectPath, this.personalDir).map((file) => this.entryOf(file));
  }

  /** The file a name points to. See `findWorkflow` for a name with no scope. */
  find(projectPath: string, id: string, scope?: WorkflowScope): WorkflowEntry | undefined {
    return findWorkflow(this.list(projectPath), id, scope);
  }

  private entryOf(file: FoundFile): WorkflowEntry {
    const base = { id: file.id, path: file.path, scope: file.scope };
    let hash = '';
    let def: WorkflowDef | null = null;
    let error: string | null = null;
    try {
      const bytes = readWorkflowFile(file.path);
      hash = bytes.hash;
      def = parseWorkflow(bytes.text);
    } catch (err) {
      error = messageOf(err);
    }
    return {
      ...base,
      hash,
      def,
      error,
      disabled: this.disabled.has(file.path),
      approval: this.approvals.stateOf(file.path, hash),
      approvedText: this.approvals.approvedText(file.path)
    };
  }

  /** A file's own text, for the editor and the change view. */
  readText(path: string): string {
    return readWorkflowFile(path).text;
  }

  private folderOf(projectPath: string, scope: WorkflowScope): string {
    return scope === 'project' ? join(projectPath, PROJECT_WORKFLOWS_DIR) : this.personalDir;
  }

  private pathOf(projectPath: string, scope: WorkflowScope, id: string): string {
    return join(this.folderOf(projectPath, scope), `${id}.toml`);
  }

  private write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  /**
   * A save from the editor. It approves the file, unless the file changed on
   * disk since it was opened: then a person sees that change first. A save
   * with `moveFrom` puts the opened file in the other scope.
   */
  save(req: SaveWorkflowRequest): SaveWorkflowResult {
    const id = slugify(req.fileName);
    const path = this.pathOf(req.projectPath, req.scope, id);
    const invalid = this.problemIn(req.text) ?? this.unsafeAt(req.projectPath, req.scope, path);
    if (invalid) return { ok: false, code: 'invalid', message: invalid };

    const { moveFrom } = req;
    if (moveFrom && moveFrom.scope !== req.scope) {
      const source = this.find(req.projectPath, moveFrom.id, moveFrom.scope);
      if (!source) return { ok: false, code: 'invalid', message: 'The file you opened is gone.' };
      const conflict = this.conflictAt(source.path, req.baseHash);
      if (conflict) return conflict;
      const refused = this.relocate(req.projectPath, source, req.scope, id, req.text, req.replace);
      if (refused) return refused;
    } else {
      const conflict = this.conflictAt(path, req.baseHash);
      if (conflict) return conflict;
      this.write(path, req.text);
    }

    this.approvals.approve(path, hashText(req.text), req.text, 'editor');
    this.onChange();
    return { ok: true, id, path };
  }

  /** Put a file in the other scope, with its approval and its on or off state. */
  move(req: MoveWorkflowRequest): MoveWorkflowResult {
    const source = this.find(req.projectPath, req.id, req.from);
    if (!source) return { ok: false, code: 'not-found', message: `No workflow named ${req.id}.` };
    let text: string;
    try {
      text = readWorkflowFile(source.path).text;
    } catch (err) {
      return { ok: false, code: 'invalid', message: messageOf(err) };
    }
    const to = otherScope(req.from);
    const refused = this.relocate(req.projectPath, source, to, source.id, text, req.replace);
    if (refused) return refused;
    this.onChange();
    return { ok: true };
  }

  /**
   * Writes `text` as `id` in scope `to` and removes the source, with its
   * approval and its on or off state. The new file is written before the old
   * one goes, so a crash loses nothing. It asks before it replaces a file.
   */
  private relocate(
    projectPath: string,
    source: WorkflowEntry,
    to: WorkflowScope,
    id: string,
    text: string,
    replace: boolean | undefined
  ): { ok: false; code: 'invalid' | 'exists'; message: string } | null {
    const path = this.pathOf(projectPath, to, id);
    const unsafe = this.unsafeAt(projectPath, to, path);
    if (unsafe) return { ok: false, code: 'invalid', message: unsafe };
    if (existsSync(path) && !replace) {
      return { ok: false, code: 'exists', message: `A ${to} workflow named ${id} exists.` };
    }
    this.write(path, text);
    this.approvals.move(source.path, path);
    this.disabled.move(source.path, path);
    rmSync(source.path, { force: true });
    return null;
  }

  /** A project is not trusted: it can ship a symlink where a save would land. */
  private unsafeAt(projectPath: string, scope: WorkflowScope, path: string): string | null {
    return scope === 'project' ? unsafeTarget(projectPath, path) : null;
  }

  problemIn(text: string): string | null {
    try {
      parseWorkflow(text);
      return null;
    } catch (err) {
      if (err instanceof WorkflowFileError) return err.message;
      throw err;
    }
  }

  private conflictAt(path: string, baseHash: string | null): SaveWorkflowResult | null {
    if (!existsSync(path)) return null;
    if (baseHash === null) {
      return { ok: false, code: 'exists', message: 'A workflow with this name exists.' };
    }
    const disk = readWorkflowFile(path);
    if (disk.hash === baseHash) return null;
    return {
      ok: false,
      code: 'changed',
      message: 'This file changed on disk.',
      diskText: disk.text
    };
  }

  /** A file from an agent or an import. It waits for a person, and never replaces a file. */
  createPending(projectPath: string, scope: WorkflowScope, id: string, text: string): string {
    const clean = slugify(id);
    const path = this.pathOf(projectPath, scope, clean);
    this.refuseBadFile(projectPath, scope, path, text);
    if (existsSync(path)) throw new WorkflowFileError(`${clean}.toml exists.`);
    this.write(path, text);
    this.onChange();
    return clean;
  }

  /**
   * A builder's next save, over the file that it saved last. A person's change
   * is never lost. A file with a new hash needs approval again.
   */
  replaceDraft(
    projectPath: string,
    scope: WorkflowScope,
    id: string,
    text: string,
    ownHash: string | null
  ): void {
    const path = this.pathOf(projectPath, scope, id);
    this.refuseBadFile(projectPath, scope, path, text);
    const current = this.find(projectPath, id, scope);
    if (!current) throw new WorkflowFileError(DRAFT_REMOVED);
    if (current.hash !== ownHash) throw new WorkflowFileError(DRAFT_CHANGED);
    this.write(path, text);
    this.onChange();
  }

  private refuseBadFile(
    projectPath: string,
    scope: WorkflowScope,
    path: string,
    text: string
  ): void {
    const problem = this.problemIn(text) ?? this.unsafeAt(projectPath, scope, path);
    if (problem) throw new WorkflowFileError(problem);
  }

  approve(projectPath: string, id: string, scope: WorkflowScope, hash: string): boolean {
    const entry = this.find(projectPath, id, scope);
    if (entry?.hash !== hash) return false;
    this.approvals.approve(entry.path, hash, this.readText(entry.path), 'person');
    this.onChange();
    return true;
  }

  /** Turn a file off or on, on this machine. False when there is no such file. */
  setDisabled(projectPath: string, id: string, scope: WorkflowScope, disabled: boolean): boolean {
    const entry = this.find(projectPath, id, scope);
    if (!entry) return false;
    this.disabled.set(entry.path, disabled);
    this.onChange();
    return true;
  }

  remove(projectPath: string, id: string, scope: WorkflowScope): void {
    const entry = this.find(projectPath, id, scope);
    if (!entry) return;
    rmSync(entry.path, { force: true });
    this.approvals.forget(entry.path);
    this.disabled.set(entry.path, false);
    this.onChange();
  }
}
