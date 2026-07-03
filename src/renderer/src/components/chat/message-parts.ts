import type { ChatMessage, ChatMessagePart } from '../../../../shared/chat-types';

/**
 * The ordered blocks to render for an assistant turn. Turns recorded with the
 * interleave fix carry `parts` directly (true chronological order). Legacy turns
 * only have a flat `content` + `toolCalls`, so we synthesize the historical
 * grouped layout — every tool card first, then the answer text — which is exactly
 * how those turns rendered before the fix.
 */
export function resolveRenderParts(message: ChatMessage): ChatMessagePart[] {
  if (message.parts?.length) return message.parts;
  const blocks: ChatMessagePart[] = (message.toolCalls ?? []).map((call) => ({
    type: 'tool',
    call
  }));
  if (message.content) blocks.push({ type: 'text', text: message.content });
  return blocks;
}
