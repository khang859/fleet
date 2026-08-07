import { join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from '../../../../shared/agent-mcp';
import { readJsonFile } from './read';
import type { FoundServer, ScanPaths } from './found';

/**
 * Servers already configured in Claude Code.
 *
 * Three places, because Claude Code has three scopes and people use all of
 * them: `~/.claude.json` holds both the servers that follow the user everywhere
 * and, under `projects`, the ones bound to a particular folder; `.mcp.json` in
 * the folder itself holds the ones meant to be committed and shared with a team.
 *
 * Nothing is written back. Fleet copies servers in and keeps its own, so a
 * server edited here does not change under Claude Code's feet.
 */

const StringMap = z.record(z.string(), z.string());

const Entry = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: StringMap.optional(),
  url: z.string().optional(),
  headers: StringMap.optional()
});

const File = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  projects: z
    .record(z.string(), z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() }))
    .optional()
});

const ProjectFile = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional()
});

export function scanClaudeCode(paths: ScanPaths): FoundServer[] {
  const found: FoundServer[] = [];

  const userPath = join(paths.home, '.claude.json');
  const user = File.safeParse(readJsonFile(userPath));
  if (user.success) {
    collect(found, user.data.mcpServers, 'user', userPath);
    // Claude Code calls this scope "local": servers the user added for one
    // folder only. It is still a project-shaped thing from Fleet's side, and
    // the path is what tells the two apart in the UI.
    collect(found, user.data.projects?.[paths.cwd]?.mcpServers, 'project', userPath);
  }

  const projectPath = join(paths.cwd, '.mcp.json');
  const project = ProjectFile.safeParse(readJsonFile(projectPath));
  if (project.success) collect(found, project.data.mcpServers, 'project', projectPath);

  return found;
}

function collect(
  into: FoundServer[],
  servers: Record<string, unknown> | undefined,
  scope: FoundServer['scope'],
  path: string
): void {
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const config = normalize(raw);
    if (config !== null) into.push({ name, config, source: 'claude-code', scope, path });
  }
}

/**
 * One entry, as Fleet's own shape.
 *
 * `type` is advisory rather than authoritative: it is optional in older configs,
 * `streamable-http` and `http` mean the same thing, and an entry carrying a
 * `url` is reachable over HTTP whatever it calls itself. So the fields decide.
 *
 * `sse` is taken as HTTP too. A server listed but missing would send the user
 * looking for why, where one that is present and reports a connection problem
 * says what is actually wrong.
 */
function normalize(raw: unknown): McpServerConfig | null {
  const parsed = Entry.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;

  if (entry.url !== undefined && entry.url !== '') {
    return { url: entry.url, headers: entry.headers, enabled: true };
  }

  if (entry.command !== undefined && entry.command !== '') {
    return { command: entry.command, args: entry.args ?? [], env: entry.env, enabled: true };
  }

  return null;
}
