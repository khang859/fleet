import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const MAX_DIFF_LINES = 60;

/**
 * A compact +/- preview of a change, capped so a huge file doesn't flood the
 * approval card. Removed lines are prefixed `-`, added lines `+`.
 */
export function buildDiff(oldText: string, newText: string): string {
  const removed = oldText ? oldText.split('\n').map((l) => `- ${l}`) : [];
  const added = newText ? newText.split('\n').map((l) => `+ ${l}`) : [];
  const lines = [...removed, ...added];
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n');
  const head = lines.slice(0, MAX_DIFF_LINES);
  return `${head.join('\n')}\n… (${lines.length - MAX_DIFF_LINES} more lines)`;
}

export type WritePlan = { newContent: string; diff: string; isNew: boolean };

/** Plan a full-file write: read the existing content (if any) to build a diff. */
export function planWrite(abs: string, content: string): WritePlan {
  const isNew = !existsSync(abs);
  const old = isNew ? '' : readFileSync(abs, 'utf8');
  return { newContent: content, diff: buildDiff(old, content), isNew };
}

/**
 * Plan a surgical edit. `oldString` must occur exactly once so the edit is
 * unambiguous. Throws otherwise (the model must provide more context).
 */
export function planEdit(abs: string, oldString: string, newString: string): WritePlan {
  if (!existsSync(abs)) throw new Error('File does not exist');
  const content = readFileSync(abs, 'utf8');
  if (oldString === newString) throw new Error('old_string and new_string are identical');
  const count = content.split(oldString).length - 1;
  if (count === 0) throw new Error('old_string not found in the file');
  if (count > 1) throw new Error(`old_string is not unique (${count} matches) — add more context`);
  const newContent = content.replace(oldString, newString);
  return { newContent, diff: buildDiff(oldString, newString), isNew: false };
}

/** Apply a planned write, creating parent directories as needed. */
export function applyWrite(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}
