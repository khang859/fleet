// src/main/sessions/rune-source.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type {
  SessionSummary,
  SessionTranscript,
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

const nodeSchema = z
  .object({
    id: z.string(),
    parent_id: z.string().optional().default(''),
    children: z.array(z.string()).optional().default([]),
    has_message: z.boolean().optional().default(false),
    message: z
      .object({ role: z.string(), content: z.array(contentBlockSchema).optional().default([]) })
      .optional(),
    created: z.string().optional()
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
    nodes: z.array(nodeSchema).optional().default([])
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
  return { summary, messages };
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
  const full = join(runeSessionsDir(), `${id}.json`);
  const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
  return readRuneTranscript(JSON.parse(raw), st.mtimeMs);
}
