import { isRecord } from './is-record';
import { jsonEqual } from './json-equal';

/**
 * Reading, editing and merging the `hooks` block of a Claude settings file.
 *
 * Two writers share this key. Fleet's copilot hook installer owns the entries
 * that invoke its own binary, and the user owns everything else. Neither may
 * overwrite the other, so every edit made in the Settings page is merged
 * against what is on disk at the moment of the write rather than against the
 * copy the page loaded.
 *
 * Ownership is decided per *entry*, not per file: an entry whose command list
 * mentions the Fleet hook binary belongs to Fleet, even if it also carries a
 * command the user added. That direction is deliberate - a shared entry is
 * taken from disk, so an installation is never lost.
 */

export type ClaudeHookCommand = {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
};

export type ClaudeHookEntry = {
  matcher?: string;
  hooks: ClaudeHookCommand[];
  [key: string]: unknown;
};

export type ClaudeHooks = Record<string, ClaudeHookEntry[]>;

/** The Fleet copilot hook binary, across every platform Fleet builds for. */
const FLEET_HOOK_PATTERN = /(^|[/\\])fleet-copilot(-[a-z0-9]+)*(\.exe|\.py)?$/i;

/**
 * Whether a command line invokes Fleet's own hook binary.
 *
 * Matched on the executable at the head of the command rather than anywhere in
 * the string, so a user hook that merely mentions the path - a log line, a
 * grep - stays the user's.
 */
export function isFleetHookCommand(command: string): boolean {
  const executable = command.trim().split(/\s+/)[0] ?? '';
  return FLEET_HOOK_PATTERN.test(executable);
}

/** Whether Fleet owns this entry, and therefore whether the page must lock it. */
export function isFleetHookEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some((h) => typeof h.command === 'string' && isFleetHookCommand(h.command));
}

/** Read the `hooks` block out of a parsed settings object, ignoring malformed parts. */
export function readHooks(document: Record<string, unknown>): ClaudeHooks {
  const raw = document.hooks;
  if (!isRecord(raw)) return {};

  const hooks: ClaudeHooks = {};
  for (const [event, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const entries: ClaudeHookEntry[] = [];
    for (const item of value) {
      if (!isRecord(item)) continue;
      const commands = Array.isArray(item.hooks) ? item.hooks.filter(isRecord) : [];
      entries.push({ ...item, hooks: commands as ClaudeHookCommand[] });
    }
    hooks[event] = entries;
  }
  return hooks;
}

/**
 * The block to write: the user's entries as edited, Fleet's entries as on disk.
 *
 * Events are emitted in the incoming block's order first so an edit keeps the
 * shape the user sees, then any event that exists only on disk. Within an
 * event, Fleet's entries lead - that is the order its installer writes - and
 * the user's follow in the order the page shows them.
 */
export function mergeHooks(incoming: ClaudeHooks, onDisk: ClaudeHooks): ClaudeHooks {
  const events = [...new Set([...Object.keys(incoming), ...Object.keys(onDisk)])];
  const merged: ClaudeHooks = {};

  for (const event of events) {
    const fleet = (onDisk[event] ?? []).filter(isFleetHookEntry);
    const mine = (incoming[event] ?? []).filter((entry) => !isFleetHookEntry(entry));
    const entries = [...fleet, ...mine];
    if (entries.length > 0) merged[event] = entries;
  }
  return merged;
}

/**
 * Whether merging changed what the caller asked to write.
 *
 * The page uses this to say "your hooks edit was not applied" - it must not
 * fire for the ordinary case where the user touched some other key and the
 * hooks block simply came back identical.
 */
export function hooksDiffer(a: ClaudeHooks, b: ClaudeHooks): boolean {
  return !jsonEqual(a, b);
}
