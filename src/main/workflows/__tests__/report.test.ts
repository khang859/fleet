import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReportPath, writeReport } from '../report';

describe('report files', () => {
  let dir: string;
  let project: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-wf-report-')));
    project = join(dir, 'project');
    mkdirSync(project);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('resolveReportPath', () => {
    it('fills placeholders and stays in the project', () => {
      expect(resolveReportPath(project, 'docs/{{slug}}.md', { slug: 'a' })).toEqual({
        path: join(project, 'docs', 'a.md')
      });
    });

    it('refuses a path outside the project', () => {
      expect(resolveReportPath(project, '../out.md', {})).toHaveProperty('refused');
      expect(resolveReportPath(project, '/etc/out.md', {})).toHaveProperty('refused');
    });

    it('refuses a value that climbs out', () => {
      const result = resolveReportPath(project, 'docs/{{slug}}.md', { slug: '../../out' });

      expect(result).toHaveProperty('refused');
    });

    it('refuses a path that is not markdown', () => {
      expect(resolveReportPath(project, 'out.txt', {})).toHaveProperty('refused');
    });

    it('refuses the folders Fleet keeps out of', () => {
      for (const folder of ['.git', '.claude', '.pi', '.fleet']) {
        expect(resolveReportPath(project, `${folder}/out.md`, {})).toHaveProperty('refused');
      }
    });

    it('refuses those names in any case, and files agents obey', () => {
      for (const rel of [
        '.Claude/out.md',
        '.GIT/out.md',
        'CLAUDE.md',
        'AGENTS.md',
        '.github/a.md'
      ]) {
        expect(resolveReportPath(project, rel, {})).toHaveProperty('refused');
      }
    });

    it('refuses a folder symlink that leads outside', () => {
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(project, 'docs'));

      const result = resolveReportPath(project, 'docs/out.md', {});

      expect(result).toEqual({ refused: 'docs/out.md leads outside the project.' });
    });

    it('refuses a folder symlink into a protected folder', () => {
      mkdirSync(join(project, '.github'));
      mkdirSync(join(project, 'docs'));
      symlinkSync(join(project, '.github'), join(project, 'docs', 'reports'));

      const result = resolveReportPath(project, 'docs/reports/foo.md', {});

      expect(result).toEqual({
        refused: 'docs/reports/foo.md is a place that Fleet does not write reports to.'
      });
    });

    it('refuses a file symlink that leads outside', () => {
      const outside = join(dir, 'outside.md');
      writeFileSync(outside, 'mine');
      symlinkSync(outside, join(project, 'out.md'));

      expect(resolveReportPath(project, 'out.md', {})).toHaveProperty('refused');
    });

    it('refuses a dangling file symlink', () => {
      symlinkSync(join(dir, 'not-there.md'), join(project, 'out.md'));

      expect(resolveReportPath(project, 'out.md', {})).toHaveProperty('refused');
    });
  });

  describe('writeReport', () => {
    it('makes a missing folder', () => {
      const path = join(project, 'a', 'b', 'out.md');

      expect(writeReport(path, 'text', false)).toEqual({ ok: true, path });
      expect(readFileSync(path, 'utf8')).toBe('text');
    });

    it('refuses to overwrite without replace', () => {
      const path = join(project, 'out.md');
      writeFileSync(path, 'old');

      expect(writeReport(path, 'new', false)).toMatchObject({ ok: false, code: 'exists' });
      expect(readFileSync(path, 'utf8')).toBe('old');
    });

    it('overwrites with replace', () => {
      const path = join(project, 'out.md');
      writeFileSync(path, 'old');

      expect(writeReport(path, 'new', true)).toEqual({ ok: true, path });
      expect(readFileSync(path, 'utf8')).toBe('new');
    });

    it('refuses a path that is not markdown', () => {
      const path = join(project, 'out.txt');

      expect(writeReport(path, 'text', true)).toMatchObject({ ok: false, code: 'refused' });
      expect(existsSync(path)).toBe(false);
    });

    it('says when the write failed', () => {
      writeFileSync(join(project, 'file'), 'x');

      const result = writeReport(join(project, 'file', 'out.md'), 'text', false);

      expect(result).toMatchObject({ ok: false, code: 'failed' });
    });
  });
});
