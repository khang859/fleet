import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../approval';
import { WorkflowCatalog } from '../catalog';
import { hashText, PROJECT_WORKFLOWS_DIR, WorkflowFileError } from '../config';

const TEXT = `name = "Task"

[[agents]]
role = "Worker"
program = "pi"
prompt = "Work."
`;
const OTHER_TEXT = TEXT.replace('Work.', 'Work harder.');

describe('WorkflowCatalog', () => {
  let dir: string;
  let project: string;
  let personal: string;
  let approvals: ApprovalStore;
  let catalog: WorkflowCatalog;

  function projectFile(id: string): string {
    return join(project, PROJECT_WORKFLOWS_DIR, `${id}.toml`);
  }

  function writeProjectFile(id: string, text: string): void {
    mkdirSync(join(project, PROJECT_WORKFLOWS_DIR), { recursive: true });
    writeFileSync(projectFile(id), text);
  }

  function saveRequest(baseHash: string | null, text = TEXT) {
    return { projectPath: project, scope: 'project' as const, fileName: 'task', text, baseHash };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-catalog-'));
    project = join(dir, 'project');
    personal = join(dir, 'personal');
    mkdirSync(project);
    approvals = new ApprovalStore(join(dir, 'approvals.json'), randomBytes(32));
    catalog = new WorkflowCatalog(approvals, personal);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says when a person changes the list', () => {
    const changed = vi.fn();
    const watched = new WorkflowCatalog(approvals, personal, changed);

    watched.save(saveRequest(null, TEXT));
    writeProjectFile('task', OTHER_TEXT);
    watched.approve(project, 'task', hashText(OTHER_TEXT));
    watched.remove(project, 'task');

    expect(changed).toHaveBeenCalledTimes(3);
  });

  describe('symlinks in a project', () => {
    it('refuses a dangling file symlink', () => {
      const target = join(dir, 'home.toml');
      mkdirSync(join(project, PROJECT_WORKFLOWS_DIR), { recursive: true });
      symlinkSync(target, projectFile('task'));

      expect(() => catalog.createPending(project, 'project', 'task', TEXT)).toThrow('symlink');
      expect(catalog.save(saveRequest(null))).toMatchObject({ ok: false, code: 'invalid' });
      expect(existsSync(target)).toBe(false);
    });

    it('refuses a folder symlink that leads outside', () => {
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(project, '.fleet'));

      expect(() => catalog.createPending(project, 'project', 'task', TEXT)).toThrow('outside');
    });
  });

  describe('list', () => {
    it('shows a parsed file that needs approval', () => {
      writeProjectFile('task', TEXT);

      const [entry] = catalog.list(project);

      expect(entry).toMatchObject({
        id: 'task',
        scope: 'project',
        error: null,
        approval: 'needs-approval',
        hash: hashText(TEXT),
        replacesPersonal: false
      });
      expect(entry.def?.name).toBe('Task');
    });

    it('shows what is wrong with a bad file', () => {
      writeProjectFile('bad', 'name = ');

      const [entry] = catalog.list(project);

      expect(entry.def).toBeNull();
      expect(entry.error).toContain('Line');
    });

    it('marks a project file that replaces a personal one', () => {
      writeProjectFile('task', TEXT);
      mkdirSync(personal);
      writeFileSync(join(personal, 'task.toml'), TEXT);

      expect(catalog.list(project)).toHaveLength(1);
      expect(catalog.find(project, 'task')?.replacesPersonal).toBe(true);
    });
  });

  describe('save', () => {
    it('writes and approves a new file', () => {
      const result = catalog.save(saveRequest(null));

      expect(result).toEqual({ ok: true, id: 'task', path: projectFile('task') });
      expect(catalog.find(project, 'task')?.approval).toBe('approved');
      expect(approvals.agentsMayStart(projectFile('task'), hashText(TEXT))).toBe(true);
    });

    it('saves to the personal folder', () => {
      const result = catalog.save({ ...saveRequest(null), scope: 'personal' });

      expect(result).toMatchObject({ ok: true, path: join(personal, 'task.toml') });
    });

    it('refuses bad text', () => {
      const result = catalog.save(saveRequest(null, 'name = '));

      expect(result).toMatchObject({ ok: false, code: 'invalid' });
      expect(existsSync(projectFile('task'))).toBe(false);
    });

    it('refuses a new file over an existing one', () => {
      writeProjectFile('task', TEXT);

      expect(catalog.save(saveRequest(null, OTHER_TEXT))).toMatchObject({
        ok: false,
        code: 'exists'
      });
      expect(readFileSync(projectFile('task'), 'utf8')).toBe(TEXT);
    });

    it('refuses a file that changed on disk and shows the change', () => {
      catalog.save(saveRequest(null));
      const baseHash = hashText(TEXT);
      writeProjectFile('task', OTHER_TEXT);

      const result = catalog.save(saveRequest(baseHash));

      expect(result).toMatchObject({ ok: false, code: 'changed', diskText: OTHER_TEXT });
      expect(catalog.find(project, 'task')?.approval).toBe('changed');
    });

    it('saves over its own version', () => {
      catalog.save(saveRequest(null));

      const result = catalog.save(saveRequest(hashText(TEXT), OTHER_TEXT));

      expect(result.ok).toBe(true);
      expect(catalog.find(project, 'task')?.approval).toBe('approved');
    });
  });

  describe('createPending', () => {
    it('writes a file that stays unapproved', () => {
      const id = catalog.createPending(project, 'project', 'New Flow', TEXT);

      expect(id).toBe('new-flow');
      expect(catalog.find(project, id)?.approval).toBe('needs-approval');
    });

    it('never replaces a file', () => {
      writeProjectFile('task', TEXT);

      expect(() => catalog.createPending(project, 'project', 'task', OTHER_TEXT)).toThrow(
        WorkflowFileError
      );
      expect(readFileSync(projectFile('task'), 'utf8')).toBe(TEXT);
    });

    it('never leaves the workflow folder', () => {
      const id = catalog.createPending(project, 'project', '../../evil', TEXT);

      expect(id).toBe('evil');
      expect(existsSync(projectFile('evil'))).toBe(true);
    });

    it('refuses bad text', () => {
      expect(() => catalog.createPending(project, 'project', 'x', 'name = ')).toThrow(
        WorkflowFileError
      );
    });
  });

  describe('approve', () => {
    it('approves the hash a person saw', () => {
      writeProjectFile('task', TEXT);

      expect(catalog.approve(project, 'task', hashText(TEXT))).toBe(true);
      expect(catalog.find(project, 'task')?.approval).toBe('approved');
      expect(catalog.find(project, 'task')?.approvedText).toBe(TEXT);
    });

    it('approves a personal file once, for every project', () => {
      const other = join(dir, 'other');
      mkdirSync(other);
      catalog.save({ ...saveRequest(null), scope: 'personal' });

      expect(catalog.find(project, 'task')?.approval).toBe('approved');
      expect(catalog.find(other, 'task')?.approval).toBe('approved');
    });

    it('refuses a hash that is out of date', () => {
      writeProjectFile('task', OTHER_TEXT);

      expect(catalog.approve(project, 'task', hashText(TEXT))).toBe(false);
    });

    it('leaves agents out until a person allows them', () => {
      writeProjectFile('task', TEXT);
      catalog.approve(project, 'task', hashText(TEXT));

      expect(approvals.agentsMayStart(projectFile('task'), hashText(TEXT))).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes the file and its approval', () => {
      catalog.save(saveRequest(null));

      catalog.remove(project, 'task');

      expect(existsSync(projectFile('task'))).toBe(false);

      writeProjectFile('task', TEXT);

      expect(catalog.find(project, 'task')?.approval).toBe('needs-approval');
    });
  });
});
