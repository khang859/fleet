import { describe, it, expect } from 'vitest';
import { conversationToMarkdown, conversationToJson, exportConversation } from '../chat-export';
import type { ChatMessage } from '../chat-types';

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>): ChatMessage {
  return {
    id: partial.id ?? 'id',
    conversationId: 'c1',
    role: partial.role,
    content: partial.content,
    parentId: partial.parentId ?? null,
    createdAt: 0,
    images: partial.images
  };
}

describe('conversationToMarkdown', () => {
  it('renders roles and preserves fenced code blocks verbatim', () => {
    const md = conversationToMarkdown('My Chat', [
      msg({ role: 'user', content: 'How do I print in JS?' }),
      msg({ role: 'assistant', content: 'Use:\n\n```js\nconsole.log(1);\n```' })
    ]);
    expect(md).toContain('# My Chat');
    expect(md).toContain('**User:**');
    expect(md).toContain('**Assistant:**');
    // Code fence survives intact.
    expect(md).toContain('```js\nconsole.log(1);\n```');
  });

  it('lists image references', () => {
    const md = conversationToMarkdown('imgs', [
      msg({
        role: 'assistant',
        content: 'here',
        images: [{ ref: 'abc123', mimeType: 'image/png', kind: 'generated' }]
      })
    ]);
    expect(md).toContain('![generated image](abc123)');
  });

  it('falls back to a default title', () => {
    expect(conversationToMarkdown('', [])).toContain('# Conversation');
  });
});

describe('exportConversation', () => {
  it('produces a markdown file by default', () => {
    const res = exportConversation(
      'Fix Login Bug',
      [msg({ role: 'user', content: 'hi' })],
      'markdown'
    );
    expect(res.filename).toBe('fix-login-bug.md');
    expect(res.mime).toBe('text/markdown');
  });

  it('produces a JSON file that parses back to the messages', () => {
    const messages = [msg({ role: 'user', content: 'hi' })];
    const res = exportConversation('T', messages, 'json');
    expect(res.filename).toBe('t.json');
    expect(res.mime).toBe('application/json');
    expect(JSON.parse(res.content)).toMatchObject({ title: 'T', messages: [{ content: 'hi' }] });
    // conversationToJson is the same content.
    expect(res.content).toBe(conversationToJson('T', messages));
  });
});
