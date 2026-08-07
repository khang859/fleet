import { join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from '../../../../shared/agent-mcp';
import { readJsonFile } from './read';
import type { FoundServer, ScanPaths } from './found';

/**
 * Servers already configured in OpenCode.
 *
 * Two places - `~/.config/opencode/opencode.json` and a config in the folder -
 * both keeping servers under `mcp` rather than `mcpServers`.
 *
 * The entries are shaped differently from everyone else's: a local server keeps
 * its command as one array with the executable at the front, and its
 * environment under `environment`. The project file may be `.jsonc`, comments
 * and all.
 */

const StringMap = z.record(z.string(), z.string());

const Entry = z.looseObject({
  type: z.string().optional(),
  command: z.array(z.string()).optional(),
  environment: StringMap.optional(),
  url: z.string().optional(),
  headers: StringMap.optional(),
  enabled: z.boolean().optional()
});

const File = z.looseObject({ mcp: z.record(z.string(), z.unknown()).optional() });

/** In order: the first that exists wins, which is how OpenCode itself reads them. */
const PROJECT_FILES = ['opencode.jsonc', 'opencode.json'];

export function scanOpenCode(paths: ScanPaths): FoundServer[] {
  const found: FoundServer[] = [];

  const userPath = join(paths.home, '.config', 'opencode', 'opencode.json');
  collect(found, userPath, 'user');

  for (const file of PROJECT_FILES) {
    const before = found.length;
    collect(found, join(paths.cwd, file), 'project');
    if (found.length > before) break;
  }

  return found;
}

function collect(into: FoundServer[], path: string, scope: FoundServer['scope']): void {
  const parsed = File.safeParse(readJsonFile(path));
  if (!parsed.success) return;

  for (const [name, raw] of Object.entries(parsed.data.mcp ?? {})) {
    const config = normalize(raw);
    if (config !== null) into.push({ name, config, source: 'opencode', scope, path });
  }
}

/**
 * One entry, as Fleet's own shape.
 *
 * `enabled` is honoured rather than defaulted: a server the user switched off in
 * OpenCode arriving switched on in Fleet would start talking to something they
 * had deliberately quietened.
 */
function normalize(raw: unknown): McpServerConfig | null {
  const parsed = Entry.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const enabled = entry.enabled ?? true;

  if (entry.url !== undefined && entry.url !== '') {
    return { url: entry.url, headers: entry.headers, enabled };
  }

  // One array with the executable at the front, which is OpenCode's own shape
  // rather than the `command` plus `args` pair everyone else writes.
  const command = entry.command ?? [];
  if (command.length > 0 && command[0] !== '') {
    return { command: command[0], args: command.slice(1), env: entry.environment, enabled };
  }

  return null;
}
