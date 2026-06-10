import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pmBoardDir, pmDocsDir, loadTaskDocs, DOC_INLINE_CAP } from '../kanban/pm-paths';

const TEST_DIR = join(tmpdir(), `fleet-pm-paths-${Date.now()}`);

describe('pm-paths', () => {
  beforeEach(() => mkdirSync(join(TEST_DIR, 'pm', 'b1', 'docs'), { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('computes board and docs dirs', () => {
    expect(pmBoardDir(TEST_DIR, 'b1')).toBe(join(TEST_DIR, 'pm', 'b1'));
    expect(pmDocsDir(TEST_DIR, 'b1')).toBe(join(TEST_DIR, 'pm', 'b1', 'docs'));
  });

  it('loads referenced docs, capping oversized ones and skipping missing ones', () => {
    const dir = pmDocsDir(TEST_DIR, 'b1');
    writeFileSync(join(dir, 'prd.md'), '# PRD\ncontent');
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(DOC_INLINE_CAP + 100));
    const docs = loadTaskDocs(dir, ['prd.md', 'big.md', 'gone.md']);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual({ filename: 'prd.md', content: '# PRD\ncontent', truncated: false });
    expect(docs[1].truncated).toBe(true);
    expect(docs[1].content).toHaveLength(DOC_INLINE_CAP);
  });
});
