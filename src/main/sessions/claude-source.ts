// src/main/sessions/claude-source.ts
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { cwdToProjectDir, parseClaudeTranscript } from '../copilot/conversation-reader';
import type { CopilotChatMessage } from '../../shared/types';
import type {
  SessionSummary,
  SessionTranscript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/sessions';

const cwdLineSchema = z.object({ cwd: z.string() }).passthrough();

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Read the cwd recorded in the first JSON line of an already-loaded transcript. */
function cwdFromTranscript(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return '';
  try {
    const parsed = cwdLineSchema.safeParse(JSON.parse(firstLine));
    return parsed.success ? parsed.data.cwd : '';
  } catch {
    return '';
  }
}

export async function listClaudeSessions(): Promise<SessionSummary[]> {
  const root = claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const projectDir of projectDirs) {
    const dirPath = join(root, projectDir);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const full = join(dirPath, file);
        const id = basename(file, '.jsonl');
        // Read each transcript once, asynchronously; parse without caching so a large
        // history doesn't accumulate state or block the main thread on every refresh.
        const [content, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
        const cwd = cwdFromTranscript(content);
        if (!cwd) continue;
        const messages = parseClaudeTranscript(content);
        if (messages.length === 0) continue;
        const preview = claudePreview(messages);
        out.push({
          agent: 'claude',
          id,
          title: preview || '(untitled)',
          project: basename(cwd),
          cwd,
          updatedAt: st.mtimeMs,
          messageCount: messages.length,
          preview: preview.slice(0, 140)
        });
      } catch {
        // skip malformed file
      }
    }
  }
  return out;
}

export async function readClaudeSession(
  id: string,
  cwd: string
): Promise<SessionTranscript | null> {
  const full = join(claudeProjectsDir(), cwdToProjectDir(cwd), `${id}.jsonl`);
  let content: string;
  let updatedAt = 0;
  try {
    const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
    content = raw;
    updatedAt = st.mtimeMs;
  } catch {
    return null; // file missing or unreadable
  }
  const messages = parseClaudeTranscript(content);
  if (messages.length === 0) return null;
  const preview = claudePreview(messages);
  return {
    summary: {
      agent: 'claude',
      id,
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt,
      messageCount: messages.length,
      preview: preview.slice(0, 140)
    },
    messages: claudeMessagesToTranscriptMessages(messages)
  };
}

export function claudeMessagesToTranscriptMessages(
  messages: CopilotChatMessage[]
): TranscriptMessage[] {
  return messages.map((m): TranscriptMessage => {
    const blocks: TranscriptBlock[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text' || b.type === 'thinking') {
        blocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use') {
        blocks.push({ type: 'tool_use', name: b.name, argsPreview: b.inputPreview, id: b.id });
      }
      // 'interrupted' blocks are dropped from the transcript view.
    }
    return { role: m.role, blocks };
  });
}

export function claudePreview(messages: CopilotChatMessage[]): string {
  for (const m of messages) {
    if (m.role === 'user') {
      const block = m.blocks.find((b) => b.type === 'text');
      if (block?.type === 'text') return block.text.trim();
    }
  }
  return '';
}
