import type { ChatToolStatusPayload } from '../../../../shared/chat-types';

/**
 * A block of the in-flight assistant turn, in the order it streamed. The live
 * counterpart to the persisted `ChatMessagePart`: a tool block here carries only
 * what the streaming `CHAT_TOOL_STATUS` events expose (label/kind/state), since
 * the full `ChatToolCall` isn't known until the turn finalizes. Rendering both
 * this and the finalized `parts` in list order is what keeps the transcript from
 * reordering when a turn completes.
 */
export type StreamingPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      label: string;
      kind?: 'image';
      state: 'generating' | 'done' | 'error';
      error?: string;
    };

type ToolStatus = Omit<ChatToolStatusPayload, 'streamId'>;

/** Append a text delta, merging into the trailing text block or starting a new one. */
export function appendTextPart(parts: StreamingPart[], delta: string): StreamingPart[] {
  if (!delta) return parts;
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
  if (last?.type === 'text') {
    return [...parts.slice(0, -1), { type: 'text', text: last.text + delta }];
  }
  return [...parts, { type: 'text', text: delta }];
}

/**
 * Fold a tool status into the ordered list. `generating` appends a new tool block
 * (after whatever text streamed before it); `done`/`error` resolve the most
 * recent still-generating block in place — tools run sequentially, so the last
 * in-flight block is always the one this status refers to.
 */
export function applyToolStatus(parts: StreamingPart[], status: ToolStatus): StreamingPart[] {
  if (status.state === 'generating') {
    return [
      ...parts,
      { type: 'tool', label: status.label, kind: status.kind, state: 'generating' }
    ];
  }
  const idx = parts.map((p) => p.type === 'tool' && p.state === 'generating').lastIndexOf(true);
  const resolved: StreamingPart = {
    type: 'tool',
    label: status.label,
    kind: status.kind,
    state: status.state,
    error: status.error
  };
  if (idx === -1) return [...parts, resolved];
  const prev = parts[idx];
  // Keep the original label/kind from when the tool started; only the state
  // (and any error) changes on resolution.
  const merged: StreamingPart =
    prev.type === 'tool' ? { ...prev, state: status.state, error: status.error } : resolved;
  return [...parts.slice(0, idx), merged, ...parts.slice(idx + 1)];
}
