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
import { ApprovalStore, DisabledFiles } from '../approval';
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
  let disabled: DisabledFiles;
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
    disabled = new DisabledFiles(join(dir, 'disabled.json'), randomBytes(32));
    catalog = new WorkflowCatalog(approvals, disabled, personal);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says when a person changes the list', () => {
    const changed = vi.fn();
    const watched = new WorkflowCatalog(approvals, disabled, personal, changed);

    watched.save(saveRequest(null, TEXT));
    writeProjectFile('task', OTHER_TEXT);
    watched.approve(project, 'task', 'project', hashText(OTHER_TEXT));
    watched.remove(project, 'task', 'project');

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
        disabled: false
      });
      expect(entry.def?.name).toBe('Task');
    });

    it('shows what is wrong with a bad file', () => {
      writeProjectFile('bad', 'name = ');

      const [entry] = catalog.list(project);

      expect(entry.def).toBeNull();
      expect(entry.error).toContain('Line');
    });

    it('lists a name in both scopes, and finds the project one first', () => {
      writeProjectFile('task', TEXT);
      mkdirSync(personal);
      writeFileSync(join(personal, 'task.toml'), OTHER_TEXT);

      expect(catalog.list(project).map((entry) => entry.scope)).toEqual(['project', 'personal']);
      expect(catalog.find(project, 'task')?.scope).toBe('project');
      expect(catalog.find(project, 'task', 'personal')?.hash).toBe(hashText(OTHER_TEXT));
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

      expect(catalog.approve(project, 'task', 'project', hashText(TEXT))).toBe(true);
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

      expect(catalog.approve(project, 'task', 'project', hashText(TEXT))).toBe(false);
    });

    it('leaves agents out until a person allows them', () => {
      writeProjectFile('task', TEXT);
      catalog.approve(project, 'task', 'project', hashText(TEXT));

      expect(approvals.agentsMayStart(projectFile('task'), hashText(TEXT))).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes the file and its approval', () => {
      catalog.save(saveRequest(null));

      catalog.remove(project, 'task', 'project');

      expect(existsSync(projectFile('task'))).toBe(false);

      writeProjectFile('task', TEXT);

      expect(catalog.find(project, 'task')?.approval).toBe('needs-approval');
    });

    it('deletes only the file of the scope it names', () => {
      catalog.save(saveRequest(null));
      catalog.save({ ...saveRequest(null), scope: 'personal' });

      catalog.remove(project, 'task', 'personal');

      expect(catalog.list(project).map((entry) => entry.scope)).toEqual(['project']);
    });
  });

  describe('move', () => {
    const personalFile = (id: string): string => join(personal, `${id}.toml`);
    const move = (from: 'project' | 'personal', replace = false) =>
      catalog.move({ projectPath: project, id: 'task', from, replace });

    it('moves a project file to personal, still approved', () => {
      catalog.save(saveRequest(null));

      expect(move('project')).toEqual({ ok: true });

      expect(existsSync(projectFile('task'))).toBe(false);
      expect(readFileSync(personalFile('task'), 'utf8')).toBe(TEXT);
      expect(catalog.list(project)).toMatchObject([{ scope: 'personal', approval: 'approved' }]);
    });

    it('moves a personal file to the project', () => {
      catalog.save({ ...saveRequest(null), scope: 'personal' });

      expect(move('personal')).toEqual({ ok: true });

      expect(catalog.list(project)).toMatchObject([{ scope: 'project', approval: 'approved' }]);
    });

    it('keeps a file that needs approval needing it', () => {
      writeProjectFile('task', TEXT);

      move('project');

      expect(catalog.find(project, 'task', 'personal')?.approval).toBe('needs-approval');
    });

    it('keeps a file that is off, off', () => {
      writeProjectFile('task', TEXT);
      catalog.setDisabled(project, 'task', 'project', true);

      move('project');

      expect(catalog.find(project, 'task', 'personal')?.disabled).toBe(true);
      expect(disabled.has(projectFile('task'))).toBe(false);
    });

    it('refuses to replace a file unless asked', () => {
      writeProjectFile('task', TEXT);
      mkdirSync(personal);
      writeFileSync(personalFile('task'), OTHER_TEXT);

      expect(move('project')).toMatchObject({ ok: false, code: 'exists' });
      expect(catalog.list(project)).toHaveLength(2);

      expect(move('project', true)).toEqual({ ok: true });
      expect(readFileSync(personalFile('task'), 'utf8')).toBe(TEXT);
      expect(catalog.list(project)).toHaveLength(1);
    });

    it('drops the approval of the file it replaces', () => {
      writeProjectFile('task', TEXT);
      catalog.save({ ...saveRequest(null, OTHER_TEXT), scope: 'personal' });

      move('project', true);

      expect(catalog.find(project, 'task', 'personal')?.approval).toBe('needs-approval');
    });

    it('says when there is no such file', () => {
      expect(move('personal')).toMatchObject({ ok: false, code: 'not-found' });
    });

    it('refuses a project symlink where the file would land', () => {
      catalog.save({ ...saveRequest(null), scope: 'personal' });
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(project, '.fleet'));

      expect(move('personal')).toMatchObject({ ok: false, code: 'invalid' });
      expect(existsSync(personalFile('task'))).toBe(true);
    });
  });

  describe('save to the other scope', () => {
    it('moves the opened file', () => {
      const first = catalog.save(saveRequest(null));
      const baseHash = hashText(TEXT);

      const result = catalog.save({
        ...saveRequest(baseHash, OTHER_TEXT),
        scope: 'personal',
        moveFrom: { id: 'task', scope: 'project' }
      });

      expect(first.ok && result.ok).toBe(true);
      expect(catalog.list(project)).toMatchObject([
        { scope: 'personal', approval: 'approved', hash: hashText(OTHER_TEXT) }
      ]);
    });

    it('asks before it replaces a file there', () => {
      catalog.save(saveRequest(null));
      catalog.save({ ...saveRequest(null, OTHER_TEXT), scope: 'personal' });
      const req = {
        ...saveRequest(hashText(TEXT)),
        scope: 'personal' as const,
        moveFrom: { id: 'task', scope: 'project' as const }
      };

      expect(catalog.save(req)).toMatchObject({ ok: false, code: 'exists' });
      expect(catalog.save({ ...req, replace: true })).toMatchObject({ ok: true });
      expect(catalog.list(project)).toMatchObject([{ scope: 'personal', hash: hashText(TEXT) }]);
    });

    it('stops when the opened file changed on disk', () => {
      catalog.save(saveRequest(null));
      writeProjectFile('task', OTHER_TEXT);

      const result = catalog.save({
        ...saveRequest(hashText(TEXT)),
        scope: 'personal',
        moveFrom: { id: 'task', scope: 'project' }
      });

      expect(result).toMatchObject({ ok: false, code: 'changed' });
      expect(existsSync(projectFile('task'))).toBe(true);
    });
  });

  describe('setDisabled', () => {
    it('turns one scope off and leaves the other on', () => {
      writeProjectFile('task', TEXT);
      mkdirSync(personal);
      writeFileSync(join(personal, 'task.toml'), TEXT);

      expect(catalog.setDisabled(project, 'task', 'personal', true)).toBe(true);

      expect(catalog.list(project).map((entry) => entry.disabled)).toEqual([false, true]);
      catalog.setDisabled(project, 'task', 'personal', false);
      expect(catalog.find(project, 'task', 'personal')?.disabled).toBe(false);
    });

    it('says when there is no such file', () => {
      expect(catalog.setDisabled(project, 'task', 'project', true)).toBe(false);
    });
  });
});
