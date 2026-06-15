// src/main/learnings/learnings-mcp-registrar.ts
// Registers the Learnings MCP server globally so the user's own terminal sessions
// pick it up: Claude Code via ~/.claude.json (key `mcpServers`), Rune via
// ~/.rune/mcp.json (key `servers`). Both honored by headless `claude -p` / `rune --prompt`.
// Fleet-spawned Rune runs get it injected into their per-workspace mcp.json instead
// (see spawn-worker.ts), which is why this exposes the current entry too.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { createLogger } from '../logger';

const log = createLogger('learnings-mcp-registrar');

const SERVER_NAME = 'fleet-learnings';

export type McpHttpEntry = { type: 'http'; url: string };

export interface RegistrarPaths {
  /** ~/.claude.json — Claude Code user-scoped config. */
  claudeJsonPath?: string;
  /** ~/.rune/mcp.json — Rune global MCP config. */
  runeMcpPath?: string;
}

// The live entry, set at startup. spawn-worker reads this to add the server to the
// per-workspace mcp.json it writes for Fleet-managed Rune runs.
let currentEntry: McpHttpEntry | null = null;

/** The current learnings MCP entry, or null before the server has started. */
export function learningsMcpEntry(): McpHttpEntry | null {
  return currentEntry;
}

const ObjectSchema = z.record(z.string(), z.unknown());

/**
 * Parse a JSON-object config file. Returns the object (or `{}` for a missing file /
 * non-object JSON), or `null` when the file exists but is unparseable — the signal to
 * leave the user's file untouched rather than clobber it.
 */
function readConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  const result = ObjectSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

/**
 * Merge `{ [SERVER_NAME]: entry }` into the object under `key`, preserving every other
 * key (the Rune file may hold API keys for other servers). Writes only when changed,
 * and never overwrites a config it couldn't parse.
 */
function mergeServerEntry(path: string, key: string, entry: McpHttpEntry): void {
  const root = readConfig(path);
  if (root === null) {
    log.warn('skipping MCP registration; config is not valid JSON', { path });
    return;
  }
  const parsedServers = ObjectSchema.safeParse(root[key]);
  const servers = parsedServers.success ? parsedServers.data : {};
  const prev = servers[SERVER_NAME];
  if (prev && JSON.stringify(prev) === JSON.stringify(entry)) return; // idempotent
  servers[SERVER_NAME] = entry;
  root[key] = servers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(root, null, 2), 'utf-8');
  log.info('registered learnings MCP server', { path, key });
}

/**
 * Point Claude Code and Rune at the learnings MCP server on `port`. Idempotent across
 * restarts when the port is stable. Each write preserves all other config.
 */
export function registerLearningsMcp(port: number, paths: RegistrarPaths = {}): void {
  const entry: McpHttpEntry = { type: 'http', url: `http://127.0.0.1:${port}/mcp` };
  currentEntry = entry;
  const claudeJsonPath = paths.claudeJsonPath ?? join(homedir(), '.claude.json');
  const runeMcpPath = paths.runeMcpPath ?? join(homedir(), '.rune', 'mcp.json');
  try {
    mergeServerEntry(claudeJsonPath, 'mcpServers', entry);
  } catch (err) {
    log.warn('failed to register with Claude Code', { error: String(err) });
  }
  try {
    mergeServerEntry(runeMcpPath, 'servers', entry);
  } catch (err) {
    log.warn('failed to register with Rune', { error: String(err) });
  }
}
