import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';
import type { ChatSecrets } from '../chat-secrets';
import { OpenRouterClient } from '../openrouter-client';
import { ChatService } from '../chat-service';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { ChatImageStorage } from '../image/image-storage';
import { ChatWorkspace } from '../chat-workspace';
import type { ChatImageProvider } from '../image/types';
import type { ChatToolExecutor } from '../tools/tool-runner';
import type { SkillManager } from '../skills/skill-manager';
import type {
  ChatMessage,
  ChatToolStatusPayload,
  ChatStreamChunkPayload
} from '../../../shared/chat-types';

/**
 * Guards the "tool calls no longer reorder when the turn finishes" fix.
 *
 * The turn streams text and tool activity in true chronological order (text →
 * tool → more text). `streamAssistant` records that interleave as an ordered
 * `parts` list on the assistant message, so the finalized transcript renders in
 * the SAME order it streamed — the tool card stays between the two prose blocks
 * instead of jumping above them.
 *
 * Deterministic, with NO Electron, network, or BrowserWindow: it stubs the model
 * client and records every emitted IPC event, exactly like chat-service.test.ts.
 */

function imgStack(base: string): { workspace: ChatWorkspace; imageStorage: ChatImageStorage } {
  const workspace = new ChatWorkspace(base, `${base}-legacy`);
  return { workspace, imageStorage: new ChatImageStorage(workspace) };
}

const stubExecutor = {
  // eslint-disable-next-line @typescript-eslint/require-await
  run: async () => ({ output: '', detail: '', decision: 'allowed', status: 'ok' })
} as unknown as ChatToolExecutor;

const stubSkills = {
  systemPrompt: () => null,
  toolDef: () => null,
  resolveInvocation: () => null,
  hasLoadSkillTool: () => false,
  runLoadSkill: () => ''
} as unknown as SkillManager;

function fakeSecrets(): ChatSecrets {
  let key: string | null = 'sk-test';
  return {
    isEncryptionAvailable: () => true,
    setKey: (k: string) => (key = k),
    getKey: () => key,
    hasKey: () => key !== null,
    clearKey: () => (key = null)
  } as unknown as ChatSecrets;
}

describe('Chat streaming vs. finalized ordering (#458 tool-call reorder)', () => {
  it('records the true text→tool→text interleave so finalized order matches streamed', async () => {
    const dir = join(tmpdir(), `fleet-chat-ordering-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const store = new ChatStore(join(dir, 'ordering.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();

    // The model narrates, calls a tool mid-thought, then narrates again:
    //   round 1: "Let me make an image. "  + generate_image
    //   round 2: "Here's the summary."     (final text, no tool)
    let round = 0;
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      round += 1;
      if (round === 1) {
        opts.onDelta('Let me make an image. ');
        return Promise.resolve({
          content: 'Let me make an image. ',
          toolCalls: [{ id: 'img_1', name: 'generate_image', arguments: '{"prompt":"a fox"}' }],
          finishReason: 'tool_calls' as const
        });
      }
      opts.onDelta("Here's the summary.");
      return Promise.resolve({
        content: "Here's the summary.",
        toolCalls: [],
        finishReason: 'stop' as const
      });
    });

    const provider: ChatImageProvider = {
      id: 'openrouter',
      generate: vi.fn(async () =>
        Promise.resolve({ data: Buffer.from('IMG'), mimeType: 'image/png' })
      )
    };
    const events: Array<{ channel: string; payload: unknown }> = [];
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      getImageModel: () => 'google/gemini-2.5-flash-image',
      getNaming: () => ({ enabled: false, model: 'x', timing: 'after-response' }),
      getAutoTag: () => ({ enabled: false, model: 'x' }),
      getToolsMode: () => 'off',
      getTools: () => ({
        mode: 'off',
        autoApprove: { safeBash: true, web: true, edits: true },
        workspaceDir: null,
        sandbox: false,
        failClosed: false,
        mentionMaxKb: 64,
        maxToolRounds: 4
      }),
      getUsage: () => ({ showMeter: true, promptCaching: false, budgetWarnUsd: null }),
      getPersonas: () => ({ presets: [], defaultId: null }),
      isWebSearchReady: () => false,
      isWebFetchReady: () => false,
      getMcpToolDefs: () => [],
      skills: stubSkills,
      toolExecutor: stubExecutor,
      imageProvider: provider,
      ...imgStack(dir),
      emit: (channel, payload) => events.push({ channel, payload })
    });

    service.send({ conversationId: conv.id, text: 'draw a fox', model: 'm', supportsTools: true });
    await vi.waitFor(() => {
      expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_DONE)).toBe(true);
    });

    // --- What the user sees WHILE streaming (true chronological order) ---
    // Reconstructed purely from the emitted IPC event log: content chunks and the
    // tool "generating" status, in the order they fired.
    const streamedOrder: string[] = [];
    for (const e of events) {
      if (e.channel === IPC_CHANNELS.CHAT_STREAM_CHUNK) {
        streamedOrder.push(`text:${(e.payload as ChatStreamChunkPayload).delta}`);
      } else if (
        e.channel === IPC_CHANNELS.CHAT_TOOL_STATUS &&
        (e.payload as ChatToolStatusPayload).state === 'generating'
      ) {
        streamedOrder.push('tool');
      }
    }
    const streamedBlocks = streamedOrder.map((b) => (b === 'tool' ? 'tool' : 'text'));
    expect(streamedBlocks).toEqual(['text', 'tool', 'text']);

    // --- What the user sees once the turn FINALIZES ---
    const assistant = store.getMessages(conv.id).at(-1) as ChatMessage;

    // `content` and `toolCalls` remain populated for backward-compatible consumers
    // (naming, tagging, export, copy) — content is the concatenated answer text.
    expect(assistant.content).toBe("Let me make an image. Here's the summary.");
    expect(assistant.toolCalls).toEqual([
      { id: 'img_1', name: 'generate_image', title: 'a fox', status: 'done' }
    ]);

    // The fix: `parts` records the true interleave, so the finalized block order
    // is IDENTICAL to what streamed — the tool sits between the two prose blocks.
    expect(assistant.parts).toEqual([
      { type: 'text', text: 'Let me make an image. ' },
      {
        type: 'tool',
        call: { id: 'img_1', name: 'generate_image', title: 'a fox', status: 'done' }
      },
      { type: 'text', text: "Here's the summary." }
    ]);
    expect(assistant.parts?.map((p) => p.type)).toEqual(streamedBlocks);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
