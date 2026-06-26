import type { ChatMessage } from './chat-types';

export type ChatExportFormat = 'markdown' | 'json';

export type ChatExportResult = { filename: string; content: string; mime: string };

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System'
};

/**
 * Render a conversation's active thread to Markdown. Message content is emitted
 * verbatim so fenced code blocks round-trip intact; images are listed as
 * Markdown image references by their stored ref.
 */
export function conversationToMarkdown(title: string, messages: ChatMessage[]): string {
  const lines: string[] = [`# ${title || 'Conversation'}`, ''];
  for (const m of messages) {
    lines.push(`**${ROLE_LABEL[m.role]}:**`, '');
    if (m.content.trim()) lines.push(m.content.trimEnd(), '');
    for (const img of m.images ?? []) {
      lines.push(`![${img.kind} image](${img.ref})`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Render a conversation to a stable JSON document (title + active-path messages). */
export function conversationToJson(title: string, messages: ChatMessage[]): string {
  return `${JSON.stringify({ title, messages }, null, 2)}\n`;
}

/** A filesystem-safe slug for the export filename, derived from the title. */
export function exportSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'conversation';
}

export function exportConversation(
  title: string,
  messages: ChatMessage[],
  format: ChatExportFormat
): ChatExportResult {
  const slug = exportSlug(title);
  if (format === 'json') {
    return {
      filename: `${slug}.json`,
      content: conversationToJson(title, messages),
      mime: 'application/json'
    };
  }
  return {
    filename: `${slug}.md`,
    content: conversationToMarkdown(title, messages),
    mime: 'text/markdown'
  };
}
