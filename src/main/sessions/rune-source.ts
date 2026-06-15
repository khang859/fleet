// src/main/sessions/rune-source.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  SessionSummary,
  SessionTranscript,
  SessionTree,
  SessionTreeNode,
  SubagentSummary,
  TokenUsage,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/sessions';

const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    args: z.unknown().optional(),
    tool_call_id: z.string().optional(),
    output: z.string().optional(),
    is_error: z.boolean().optional()
  })
  .passthrough();

// Rune's ai.Usage struct has no JSON tags, so Go serializes the keys capitalized.
const usageSchema = z
  .object({
    Input: z.number().optional(),
    Output: z.number().optional(),
    CacheRead: z.number().optional()
  })
  .partial();

const nodeSchema = z
  .object({
    id: z.string(),
    parent_id: z.string().optional().default(''),
    children: z.array(z.string()).optional().default([]),
    has_message: z.boolean().optional().default(false),
    message: z
      .object({
        role: z.string(),
        // Rune writes `content: null` on nodes without message content; coerce
        // null/undefined to [] so one such node can't fail the whole session.
        content: z
          .array(contentBlockSchema)
          .nullish()
          .transform((v) => v ?? [])
      })
      .optional(),
    created: z.string().optional(),
    usage: usageSchema.optional(),
    compacted_count: z.number().optional()
  })
  .passthrough();

const subagentSchema = z
  .object({
    task_id: z.string(),
    name: z.string().optional().default(''),
    agent_type: z.string().optional(),
    status: z.string().optional().default(''),
    summary: z.string().optional()
  })
  .passthrough();

export const runeSessionSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    created: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional().default(''),
    root_id: z.string().optional().default(''),
    active_id: z.string().optional().default(''),
    nodes: z.array(nodeSchema).optional().default([]),
    subagents: z.array(subagentSchema).optional().default([])
  })
  .passthrough();

export type RuneSession = z.infer<typeof runeSessionSchema>;

/** Walk root -> active_id and return nodes that carry a message, in chronological order. */
function activePath(session: RuneSession): RuneSession['nodes'] {
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  const chain: RuneSession['nodes'] = [];
  let current = byId.get(session.active_id);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    if (current.has_message && current.message) chain.push(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return chain.reverse();
}

function firstUserText(path: RuneSession['nodes']): string {
  for (const node of path) {
    if (node.message?.role === 'user') {
      const text = node.message.content.find((b) => b.type === 'text')?.text;
      if (text) return text.trim();
    }
  }
  return '';
}

function toRole(role: string): TranscriptMessage['role'] {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  return 'tool';
}

function toBlocks(content: Array<z.infer<typeof contentBlockSchema>>): TranscriptBlock[] {
  return content.map((b): TranscriptBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text ?? '' };
      case 'tool_use':
        return {
          type: 'tool_use',
          name: b.name ?? 'tool',
          argsPreview: typeof b.args === 'string' ? b.args : JSON.stringify(b.args ?? {}),
          id: b.id
        };
      case 'tool_result':
        return {
          type: 'tool_result',
          toolCallId: b.tool_call_id,
          output: b.output ?? '',
          isError: b.is_error
        };
      default:
        return { type: 'image' };
    }
  });
}

function parseCreated(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function mapUsage(usage?: z.infer<typeof usageSchema>): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.Input ?? 0;
  const output = usage.Output ?? 0;
  const cacheRead = usage.CacheRead ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0) return undefined;
  return { input, output, cacheRead };
}

function nodePreview(content: Array<z.infer<typeof contentBlockSchema>>): string {
  const text = content.find((b) => b.type === 'text')?.text ?? '';
  return text.trim().replace(/\s+/g, ' ').slice(0, 80);
}

/** Nearest ancestor that carries a message, skipping the empty root and any message-less nodes. */
function nearestMessageAncestor(
  node: RuneSession['nodes'][number],
  byId: Map<string, RuneSession['nodes'][number]>
): string | null {
  const seen = new Set<string>();
  let parent = node.parent_id ? byId.get(node.parent_id) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (parent.has_message && parent.message) return parent.id;
    parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
  }
  return null;
}

/**
 * Reconstruct the message-bearing graph. The empty root node is dropped; its children
 * become top-level nodes (parentId null). Returns undefined for linear sessions so the
 * renderer falls back to the plain transcript view.
 */
function buildTree(session: RuneSession): SessionTree | undefined {
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  const msgNodes = session.nodes.filter((n) => n.has_message && n.message);

  const parentOf = new Map<string, string | null>();
  for (const n of msgNodes) parentOf.set(n.id, nearestMessageAncestor(n, byId));

  const childrenOf = new Map<string, string[]>();
  for (const n of msgNodes) {
    const parent = parentOf.get(n.id);
    if (!parent) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(n.id);
    else childrenOf.set(parent, [n.id]);
  }

  const topLevelCount = msgNodes.filter((n) => parentOf.get(n.id) === null).length;
  const hasBranches =
    topLevelCount > 1 || msgNodes.some((n) => (childrenOf.get(n.id)?.length ?? 0) > 1);
  if (!hasBranches) return undefined;

  const nodes: SessionTreeNode[] = msgNodes.map((n) => ({
    id: n.id,
    parentId: parentOf.get(n.id) ?? null,
    childIds: childrenOf.get(n.id) ?? [],
    role: toRole(n.message!.role),
    blocks: toBlocks(n.message!.content),
    createdAt: parseCreated(n.created),
    usage: mapUsage(n.usage),
    compactedCount: n.compacted_count && n.compacted_count > 0 ? n.compacted_count : undefined,
    preview: nodePreview(n.message!.content)
  }));

  // active_id is usually a leaf message node, but guard against it pointing at the
  // message-less root (or a stray id) so the renderer never defaults to a blank path.
  const msgIds = new Set(msgNodes.map((n) => n.id));
  const rawActive = byId.get(session.active_id);
  const activeId = msgIds.has(session.active_id)
    ? session.active_id
    : ((rawActive ? nearestMessageAncestor(rawActive, byId) : null) ?? nodes[nodes.length - 1].id);

  return { activeId, nodes };
}

function mapSubagents(subagents: RuneSession['subagents']): SubagentSummary[] | undefined {
  if (subagents.length === 0) return undefined;
  return subagents.map((s) => ({
    id: s.task_id,
    name: s.name,
    agentType: s.agent_type,
    status: s.status,
    summary: s.summary || undefined
  }));
}

export function summarizeRune(raw: unknown, updatedAt: number): SessionSummary | null {
  const parsed = runeSessionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const session = parsed.data;
  const path = activePath(session);
  const preview = firstUserText(path);
  return {
    agent: 'rune',
    id: session.id,
    title: session.name?.trim() || preview || '(untitled)',
    project: session.cwd ? basename(session.cwd) : '(no project)',
    cwd: session.cwd,
    model: session.model,
    provider: session.provider,
    updatedAt,
    messageCount: path.length,
    preview: preview.slice(0, 140)
  };
}

export function readRuneTranscript(raw: unknown, updatedAt: number): SessionTranscript | null {
  const summary = summarizeRune(raw, updatedAt);
  if (!summary) return null;
  const session = runeSessionSchema.parse(raw);
  const messages = activePath(session).map(
    (node): TranscriptMessage => ({
      role: toRole(node.message!.role),
      blocks: toBlocks(node.message!.content)
    })
  );
  const result: SessionTranscript = { summary, messages };
  const tree = buildTree(session);
  if (tree) result.tree = tree;
  const subagents = mapSubagents(session.subagents);
  if (subagents) result.subagents = subagents;
  return result;
}

export function runeSessionsDir(): string {
  const base =
    process.env.RUNE_DIR && process.env.RUNE_DIR.length > 0
      ? process.env.RUNE_DIR
      : join(homedir(), '.rune');
  return join(base, 'sessions');
}

export async function listRuneSessions(): Promise<SessionSummary[]> {
  const dir = runeSessionsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // dir may not exist
  }
  const out: SessionSummary[] = [];
  for (const file of files) {
    try {
      const full = join(dir, file);
      const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
      const summary = summarizeRune(JSON.parse(raw), st.mtimeMs);
      if (summary) out.push(summary);
    } catch {
      // skip malformed file
    }
  }
  return out;
}

export async function readRuneSession(id: string): Promise<SessionTranscript | null> {
  const dir = runeSessionsDir();
  const full = join(dir, `${id}.json`);
  // Guard against path traversal via a crafted id (e.g. "../../.ssh/key"): the
  // resolved path must stay inside the sessions directory.
  if (resolve(full) !== resolve(dir) && !resolve(full).startsWith(resolve(dir) + sep)) {
    return null;
  }
  try {
    const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
    return readRuneTranscript(JSON.parse(raw), st.mtimeMs);
  } catch {
    return null; // file missing, unreadable, or malformed
  }
}
