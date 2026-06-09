// src/main/sessions/claude-source.ts
import type { CopilotChatMessage } from '../../shared/types';
import type { TranscriptBlock, TranscriptMessage } from '../../shared/sessions';

export function claudeMessagesToTranscriptMessages(messages: CopilotChatMessage[]): TranscriptMessage[] {
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
      const text = m.blocks.find((b) => b.type === 'text');
      if (text && text.type === 'text') return text.text.trim();
    }
  }
  return '';
}
