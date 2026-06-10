import { readFileSync } from 'fs';
import { join } from 'path';

/** Per-doc cap when inlining board docs into a worker prompt. */
export const DOC_INLINE_CAP = 32 * 1024;

/** The PM's cwd for a board — also the board's knowledge home (AGENTS.md, MEMORY.md, docs/). */
export function pmBoardDir(kanbanHome: string, boardId: string): string {
  return join(kanbanHome, 'pm', boardId);
}

/** PM-authored living docs (PRDs/specs) for a board. */
export function pmDocsDir(kanbanHome: string, boardId: string): string {
  return join(pmBoardDir(kanbanHome, boardId), 'docs');
}

export interface InlinedDoc {
  filename: string;
  content: string;
  truncated: boolean;
}

/**
 * Read a task's referenced board docs for prompt inlining. Missing files are
 * skipped (a deleted doc must never break dispatch); oversized ones are capped.
 */
export function loadTaskDocs(docsDir: string, names: string[]): InlinedDoc[] {
  const out: InlinedDoc[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(docsDir, name), 'utf-8');
    } catch {
      continue;
    }
    const truncated = raw.length > DOC_INLINE_CAP;
    out.push({ filename: name, content: truncated ? raw.slice(0, DOC_INLINE_CAP) : raw, truncated });
  }
  return out;
}
