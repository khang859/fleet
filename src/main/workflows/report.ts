import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { SaveReportResult } from '../../shared/workflows';
import { RepoPath } from '../worktree-config';
import { fillPlaceholders } from './config';

/**
 * Names a report must never land in or on, in lower case: a folder name is one
 * name in any case on macOS and Windows. These hold what agents obey or run.
 */
const REFUSED_NAMES = new Set([
  '.git',
  '.github',
  '.claude',
  '.pi',
  '.fleet',
  'claude.md',
  'agents.md'
]);

/** The deepest folder on the way to `path` that exists. */
function deepestExisting(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir)) dir = dirname(dir);
  return dir;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Why a write to `path` could land outside `root`, or null. It follows no symlink. */
export function unsafeTarget(root: string, path: string): string | null {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return `${relative(root, path)} is a symlink.`;
  }
  const isInside = inside(realpathSync(root), realpathSync(deepestExisting(path)));
  return isInside ? null : `${relative(root, path)} leads outside the project.`;
}

/**
 * The file a workflow's `path` names in a project, or a reason it is refused.
 * Checked after the placeholders are filled, and on the real folder, so a
 * symlink cannot lead outside.
 */
export function resolveReportPath(
  projectPath: string,
  template: string,
  values: Record<string, string>
): { path: string } | { refused: string } {
  const filled = fillPlaceholders(template, values);
  const parsed = RepoPath.safeParse(filled);
  if (!parsed.success) return { refused: `${filled} is not a path inside the project.` };
  const rel = parsed.data;
  if (!rel.endsWith('.md')) return { refused: 'A report path must end in .md.' };
  if (rel.split('/').some((part) => REFUSED_NAMES.has(part.toLowerCase()))) {
    return { refused: `${rel} is a place that Fleet does not write reports to.` };
  }
  const path = join(projectPath, rel);
  const unsafe = unsafeTarget(projectPath, path);
  return unsafe ? { refused: unsafe } : { path };
}

/** Write a report. A missing folder is made, and an existing file needs `replace`. */
export function writeReport(path: string, text: string, replace: boolean): SaveReportResult {
  if (!path.endsWith('.md')) {
    return { ok: false, code: 'refused', message: 'A report path must end in .md.' };
  }
  if (!replace && existsSync(path)) {
    return { ok: false, code: 'exists', message: `${path} exists.` };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
