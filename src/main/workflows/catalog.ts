import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SaveWorkflowRequest,
  SaveWorkflowResult,
  WorkflowDef,
  WorkflowEntry,
  WorkflowScope
} from '../../shared/workflows';
import type { ApprovalStore } from './approval';
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The workflow files of a project, and what a person may do with them. */
export class WorkflowCatalog {
  constructor(
    private readonly approvals: ApprovalStore,
    private readonly personalDir: string,
    /** Called after Fleet itself changes what `list` answers. */
    private readonly onChange: () => void = () => undefined
  ) {}

  list(projectPath: string): WorkflowEntry[] {
    const { files, replaced } = findWorkflowFiles(projectPath, this.personalDir);
    return files.map((file) => this.entryOf(file, replaced.has(file.id)));
  }

  find(projectPath: string, id: string): WorkflowEntry | undefined {
    return this.list(projectPath).find((entry) => entry.id === id);
  }

  private entryOf(file: FoundFile, replacesPersonal: boolean): WorkflowEntry {
    const base = { id: file.id, path: file.path, scope: file.scope, replacesPersonal };
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

  private write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  /**
   * A save from the editor. It approves the file, unless the file changed on
   * disk since it was opened: then a person sees that change first.
   */
  save(req: SaveWorkflowRequest): SaveWorkflowResult {
    const id = slugify(req.fileName);
    const path = join(this.folderOf(req.projectPath, req.scope), `${id}.toml`);
    const invalid = this.problemIn(req.text);
    if (invalid) return { ok: false, code: 'invalid', message: invalid };

    const unsafe = this.unsafeAt(req.projectPath, req.scope, path);
    if (unsafe) return { ok: false, code: 'invalid', message: unsafe };

    const conflict = this.conflictAt(path, req.baseHash);
    if (conflict) return conflict;

    this.write(path, req.text);
    this.approvals.approve(path, hashText(req.text), req.text, 'editor');
    this.onChange();
    return { ok: true, id, path };
  }

  /** A project is not trusted: it can ship a symlink where a save would land. */
  private unsafeAt(projectPath: string, scope: WorkflowScope, path: string): string | null {
    return scope === 'project' ? unsafeTarget(projectPath, path) : null;
  }

  private problemIn(text: string): string | null {
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
    const path = join(this.folderOf(projectPath, scope), `${clean}.toml`);
    const invalid = this.problemIn(text);
    if (invalid) throw new WorkflowFileError(invalid);
    const unsafe = this.unsafeAt(projectPath, scope, path);
    if (unsafe) throw new WorkflowFileError(unsafe);
    if (existsSync(path)) throw new WorkflowFileError(`${clean}.toml exists.`);
    this.write(path, text);
    this.onChange();
    return clean;
  }

  approve(projectPath: string, id: string, hash: string): boolean {
    const entry = this.find(projectPath, id);
    if (entry?.hash !== hash) return false;
    this.approvals.approve(entry.path, hash, this.readText(entry.path), 'person');
    this.onChange();
    return true;
  }

  remove(projectPath: string, id: string): void {
    const entry = this.find(projectPath, id);
    if (!entry) return;
    rmSync(entry.path, { force: true });
    this.approvals.forget(entry.path);
    this.onChange();
  }
}
