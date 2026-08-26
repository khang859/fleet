import type { Tab } from '../../../shared/types';
import type { PathContext } from '../../../shared/shell-profiles';

/**
 * A file tab opened from a terminal session hangs off that session in the
 * sidebar, indented under it. The relation lives on the child (`parentTabId`)
 * and is only ever a display one: nothing about the pane, its PTY or its
 * lifetime changes, and a child whose parent is gone falls back to the top
 * level rather than disappearing with it.
 */

/** A session is a shell tab - the thing files get opened *from*. */
export function isSessionTab(tab: Tab): boolean {
  return tab.type === undefined || tab.type === 'terminal';
}

/** The tab kinds that open a file and can therefore nest under a session. */
export function isFileTab(tab: Tab): boolean {
  return (
    tab.type === 'file' || tab.type === 'image' || tab.type === 'markdown' || tab.type === 'pdf'
  );
}

/**
 * The parent this tab actually nests under, or undefined if it nests nowhere.
 * A dangling `parentTabId` (its session was closed) resolves to undefined, so
 * the file promotes itself back to the top level without any cleanup pass -
 * and re-nests if an undo-close brings the session back.
 */
export function nestParentId(byId: Map<string, Tab>, tab: Tab): string | undefined {
  if (!tab.parentTabId || !isFileTab(tab)) return undefined;
  const parent = byId.get(tab.parentTabId);
  return parent && isSessionTab(parent) ? parent.id : undefined;
}

export type TabNesting = {
  /** Session id → the file tabs under it, in list order (newest first). */
  childrenByParent: Map<string, Tab[]>;
  /** Tabs drawn under a session, so the top-level pass has to skip them. */
  nestedIds: Set<string>;
};

export function buildTabNesting(tabs: Tab[]): TabNesting {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const childrenByParent = new Map<string, Tab[]>();
  const nestedIds = new Set<string>();
  for (const tab of tabs) {
    const parentId = nestParentId(byId, tab);
    if (!parentId) continue;
    nestedIds.add(tab.id);
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(tab);
    else childrenByParent.set(parentId, [tab]);
  }
  return { childrenByParent, nestedIds };
}

/**
 * How many tabs move as one when the tab at `index` is dragged: a session takes
 * the run of its own file tabs sitting right after it, so the nest travels with
 * the row the user grabbed. Anything else moves alone.
 */
export function nestedBlockLength(tabs: Tab[], index: number): number {
  // `.at` rather than `[index]`, which types as `Tab` even when out of range.
  const tab = tabs.at(index);
  if (!tab || !isSessionTab(tab)) return 1;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  let length = 1;
  while (index + length < tabs.length && nestParentId(byId, tabs[index + length]) === tab.id) {
    length++;
  }
  return length;
}

/**
 * Where a tab dropped at `index` may actually land: never between a session and
 * its files, which would cut them loose from it. A drop aimed into a nest lands
 * after the whole nest instead.
 */
export function nestInsertIndex(tabs: Tab[], index: number): number {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  let i = index;
  while (i < tabs.length && nestParentId(byId, tabs[i]) !== undefined) i++;
  return i;
}

/** Newest file directly under its session; parentless files go to the end. */
export function insertNestedTab(tabs: Tab[], tab: Tab, parentTabId: string | undefined): Tab[] {
  const parentIndex = parentTabId ? tabs.findIndex((t) => t.id === parentTabId) : -1;
  if (parentIndex === -1) return [...tabs, tab];
  const next = [...tabs];
  next.splice(parentIndex + 1, 0, tab);
  return next;
}

/** Case- and separator-insensitive on win32, where both vary for one directory. */
function normalizeDir(path: string, ctx: PathContext): string {
  const unified = ctx === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path;
  return unified.replace(/\/+$/, '') || '/';
}

function containsPath(dir: string, filePath: string, ctx: PathContext): boolean {
  const d = normalizeDir(dir, ctx);
  const f = ctx === 'win32' ? filePath.replace(/\\/g, '/').toLowerCase() : filePath;
  return f.startsWith(d.endsWith('/') ? d : `${d}/`);
}

/**
 * Which session a newly opened file belongs under. The session the user was
 * looking at is the honest answer - including when they were looking at a file
 * that is itself nested, since that is still the session they are working in.
 * Failing that (a file opened from the dashboard with nothing focused, or from
 * the CLI), the deepest session whose directory contains the file.
 */
export function resolveFileParentId(
  tabs: Tab[],
  activeTabId: string | null | undefined,
  filePath: string,
  cwdOf: (tab: Tab) => string
): string | undefined {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) {
    const candidate =
      isFileTab(active) && active.parentTabId
        ? tabs.find((t) => t.id === active.parentTabId)
        : active;
    if (candidate && isSessionTab(candidate)) return candidate.id;
  }

  let best: Tab | undefined;
  let bestDepth = -1;
  for (const tab of tabs) {
    if (!isSessionTab(tab)) continue;
    const ctx = tab.pathContext ?? 'posix';
    const dir = normalizeDir(cwdOf(tab), ctx);
    if (dir.length <= bestDepth || !containsPath(dir, filePath, ctx)) continue;
    best = tab;
    bestDepth = dir.length;
  }
  return best?.id;
}
