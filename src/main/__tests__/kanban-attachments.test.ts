import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync, readFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import {
  sanitizeFilename,
  contentTypeFor,
  prepareAttachmentFile,
  removeAttachmentFile
} from '../kanban/attachments';

const ROOT = join(tmpdir(), `fleet-kanban-att-test-${process.pid}`);
const ATT_ROOT = join(ROOT, 'attachments');

function makeSource(name: string, bytes: number | string): string {
  const p = join(ROOT, name);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(p, typeof bytes === 'number' ? Buffer.alloc(bytes) : bytes);
  return p;
}

describe('kanban attachments helper', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('sanitizeFilename strips separators and control chars', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a/b/c.txt')).toBe('c.txt');
    expect(sanitizeFilename('evil\nname.txt')).toBe('evilname.txt');
    expect(sanitizeFilename('a`b```c.txt')).toBe('abc.txt');
    expect(sanitizeFilename('')).toBe('file');
  });

  it('contentTypeFor maps known extensions and returns null otherwise', () => {
    expect(contentTypeFor('a.md')).toBe('text/markdown');
    expect(contentTypeFor('a.PNG')).toBe('image/png');
    expect(contentTypeFor('noext')).toBeNull();
    expect(contentTypeFor('a.weirdext')).toBeNull();
  });

  it('prepareAttachmentFile copies into attachments/<task>/<id>__<name>', () => {
    const src = makeSource('hello.txt', 'hi');
    const out = prepareAttachmentFile({
      attachmentsRoot: ATT_ROOT,
      taskId: 'task1',
      attachmentId: 'aaaa1111',
      sourcePath: src
    });
    expect(out.filename).toBe('hello.txt');
    expect(out.storedPath).toBe(join(ATT_ROOT, 'task1', 'aaaa1111__hello.txt'));
    expect(out.contentType).toBe('text/plain');
    expect(out.size).toBe(2);
    expect(existsSync(out.storedPath)).toBe(true);
    expect(readFileSync(out.storedPath, 'utf8')).toBe('hi');
  });

  it('prepareAttachmentFile rejects files over 25 MB', () => {
    const src = makeSource('big.bin', 25 * 1024 * 1024 + 1);
    expect(() =>
      prepareAttachmentFile({
        attachmentsRoot: ATT_ROOT,
        taskId: 't',
        attachmentId: 'id1',
        sourcePath: src
      })
    ).toThrow(/25 MB/);
  });

  it('prepareAttachmentFile rejects non-regular files (symlink)', () => {
    const target = makeSource('real.txt', 'x');
    const link = join(ROOT, 'link.txt');
    symlinkSync(target, link);
    expect(() =>
      prepareAttachmentFile({
        attachmentsRoot: ATT_ROOT,
        taskId: 't',
        attachmentId: 'id2',
        sourcePath: link
      })
    ).toThrow(/regular file/);
  });

  it('keeps the stored path inside the task dir and rejects a crafted traversal', () => {
    const src = makeSource('payload', 'x');
    const out = prepareAttachmentFile({
      attachmentsRoot: ATT_ROOT,
      taskId: 'tt',
      attachmentId: 'idz',
      sourcePath: src
    });
    expect(out.storedPath.startsWith(join(ATT_ROOT, 'tt') + sep)).toBe(true);

    expect(() =>
      prepareAttachmentFile({
        attachmentsRoot: ATT_ROOT,
        taskId: 'tt',
        attachmentId: '../../../etc',
        sourcePath: src
      })
    ).toThrow(/escapes the task directory/);
  });

  it('removeAttachmentFile is a no-op when the file is already gone', () => {
    expect(() => removeAttachmentFile(join(ATT_ROOT, 'nope', 'x'))).not.toThrow();
  });
});
