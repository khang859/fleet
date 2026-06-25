# Chat (OpenRouter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a general-purpose AI chat assistant to Fleet — a pinned **Chat** tool in the Tools section, backed by OpenRouter, with multiple persisted conversations, streaming markdown responses, a live model picker, and an in-tool settings view for the API key.

**Architecture:** Three layers following Fleet conventions. (1) Main process `src/main/chat/`: an OpenRouter client (native `fetch` + SSE), a `better-sqlite3` conversation store, a `safeStorage`-encrypted API-key store, and a service that orchestrates streaming over IPC. (2) IPC layer: a `chat:` channel domain (invoke handlers + main→renderer stream events) wired through `ipc-channels.ts` / `preload` / `ipc-handlers.ts`. (3) Renderer: a Zustand `chat-store` and components under `src/renderer/src/components/chat/`, rendered as a special tab (`type: 'chat'`).

**Tech Stack:** Electron (main = Node 18+, native `fetch`), `better-sqlite3@12`, Electron `safeStorage`, `electron-store`, React + TypeScript, Zustand, Tailwind + Fleet semantic tokens, Radix primitives, `react-markdown@10` + `remark-gfm` + `rehype-highlight`, `lucide-react`. Tests: Vitest.

**Design spec:** `docs/superpowers/specs/2026-06-24-chat-openrouter-design.md`

## Global Constraints

- **No new runtime dependencies.** Reuse `fetch` (built-in), `better-sqlite3@^12.8.0`, `electron-store`, `safeStorage`, `react-markdown@^10.1.0`. (Verbatim from spec §2/§6.)
- **No unsafe type assertions** (`as`) or `eslint-disable` in `src/`. Use zod or explicit narrowing for runtime data. (Project rule.)
- **OpenRouter chat-completions shape only** — `choices[0].delta.content`, not the "Responses" API. (Spec §6.)
- **API key plaintext never crosses IPC to the renderer.** Renderer only ever learns `hasKey: boolean`. (Spec §3.)
- **Settings read = defaults merged under stored values** so future fields need no migration. (Spec §3.)
- **Streaming via fire-and-forget events** keyed by `streamId`; invoke handlers never hold a stream open. (Spec §2.2.)
- **Verification commands:** `npm run typecheck`, `npm run lint`, `npm run build`. Single test file: `npx vitest run <path>`. Full suite: `npm run test`.
- **Tests** live in `__tests__/` dirs named `*.test.ts`.

---

## File Structure

**New — shared:**
- `src/shared/chat-types.ts` — all Chat domain types (messages, conversations, models, settings, IPC payloads).

**New — main:**
- `src/main/chat/openrouter-client.ts` — `OpenRouterClient` (`listModels`, `streamCompletion`) + pure `consumeSSE` helper.
- `src/main/chat/chat-secrets.ts` — `ChatSecrets` (safeStorage-encrypted API key).
- `src/main/chat/chat-store.ts` — `ChatStore` (SQLite conversations + messages).
- `src/main/chat/chat-service.ts` — `ChatService` (orchestrates send→stream→persist→events).
- `src/main/chat/chat-ipc.ts` — `registerChatIpc(deps)` (handler registration).

**New — renderer:**
- `src/renderer/src/store/chat-store.ts` — Zustand store.
- `src/renderer/src/components/chat/ChatTab.tsx` — shell + view switcher (Chat / Settings).
- `src/renderer/src/components/chat/ChatView.tsx` — rail + messages + composer.
- `src/renderer/src/components/chat/ConversationList.tsx`
- `src/renderer/src/components/chat/MessageList.tsx`
- `src/renderer/src/components/chat/Composer.tsx`
- `src/renderer/src/components/chat/ModelPicker.tsx`
- `src/renderer/src/components/chat/ChatSettingsView.tsx`

**Modified:**
- `src/shared/ipc-channels.ts` — `CHAT_*` channels.
- `src/shared/types.ts` — `Tab.type` union += `'chat'`; `FleetSettings.ai`.
- `src/shared/constants.ts` — `DEFAULT_SETTINGS.ai`.
- `src/shared/tools.ts` — `ToolType` += `'chat'`, registry + default visibility.
- `src/main/settings-store.ts` — merge `ai` in `get()`/`set()`.
- `src/main/ipc-handlers.ts` (+ `src/main/index.ts`) — construct chat deps + call `registerChatIpc`.
- `src/preload/index.ts` — `chat` block on `fleetApi`.
- `src/renderer/src/App.tsx` — render `<ChatTab/>` for `tab.type === 'chat'`; pinned mini-sidebar icon.
- `src/renderer/src/store/workspace-store.ts` — `ensureChatTab`.
- `src/renderer/src/components/Sidebar.tsx` — Chat in Tools section (via `TOGGLEABLE_TOOLS`, mechanical).

---

## Task 1: Shared scaffolding (types, channels, settings, tool registry)

Pure type/constant additions wired through the settings merge. Deliverable: the app typechecks with all Chat types and the `ai` settings branch present, and a unit test proves the settings merge fills defaults.

**Files:**
- Create: `src/shared/chat-types.ts`
- Modify: `src/shared/ipc-channels.ts` (append to `IPC_CHANNELS`)
- Modify: `src/shared/types.ts` (`Tab.type` union; `FleetSettings.ai`)
- Modify: `src/shared/constants.ts` (`DEFAULT_SETTINGS.ai`)
- Modify: `src/shared/tools.ts` (`ToolType`, registry, default visibility)
- Modify: `src/main/settings-store.ts` (`get()` merge; `set()` merge)
- Test: `src/main/__tests__/settings-store-ai.test.ts`

**Interfaces:**
- Produces (consumed by every later task):
  ```ts
  export type ChatRole = 'user' | 'assistant' | 'system';
  export type ChatMessage = { id: string; conversationId: string; role: ChatRole; content: string; createdAt: number };
  export type ChatConversation = { id: string; title: string; model: string | null; createdAt: number; updatedAt: number };
  export type ChatModel = { id: string; name: string; contextLength: number };
  export type ChatSettings = { provider: 'openrouter'; defaultModel: string };
  export type AiSettings = { chat: ChatSettings };
  export type ChatCompletionMessage = { role: ChatRole; content: string };
  export type ChatSendRequest = { conversationId: string; text: string; model: string };
  export type ChatSendResponse = { streamId: string; userMessage: ChatMessage };
  export type ChatStreamChunkPayload = { streamId: string; delta: string };
  export type ChatStreamDonePayload = { streamId: string; message: ChatMessage };
  export type ChatStreamErrorPayload = { streamId: string; message: string; partial: string };
  export const DEFAULT_CHAT_SETTINGS: ChatSettings;
  export const DEFAULT_AI_SETTINGS: AiSettings;
  ```
- `IPC_CHANNELS.CHAT_*` string constants (see Step 2).

- [ ] **Step 1: Create the shared types file**

Create `src/shared/chat-types.ts`:

```ts
export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type ChatConversation = {
  id: string;
  title: string;
  /** Per-conversation model override; null → use the default model. */
  model: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ChatModel = {
  id: string;
  name: string;
  contextLength: number;
};

export type ChatSettings = {
  provider: 'openrouter';
  defaultModel: string;
};

/** Capability-namespaced AI settings. Future: image, video slot in here additively. */
export type AiSettings = {
  chat: ChatSettings;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  provider: 'openrouter',
  defaultModel: 'anthropic/claude-3.5-sonnet'
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  chat: DEFAULT_CHAT_SETTINGS
};

/** One message in an OpenRouter chat-completions request. */
export type ChatCompletionMessage = { role: ChatRole; content: string };

export type ChatSendRequest = { conversationId: string; text: string; model: string };
export type ChatSendResponse = { streamId: string; userMessage: ChatMessage };

export type ChatStreamChunkPayload = { streamId: string; delta: string };
export type ChatStreamDonePayload = { streamId: string; message: ChatMessage };
export type ChatStreamErrorPayload = { streamId: string; message: string; partial: string };
```

- [ ] **Step 2: Add IPC channels**

In `src/shared/ipc-channels.ts`, inside the `IPC_CHANNELS` object (next to the other domains), add:

```ts
  CHAT_LIST_CONVERSATIONS: 'chat:list-conversations',
  CHAT_CREATE_CONVERSATION: 'chat:create-conversation',
  CHAT_RENAME_CONVERSATION: 'chat:rename-conversation',
  CHAT_DELETE_CONVERSATION: 'chat:delete-conversation',
  CHAT_GET_MESSAGES: 'chat:get-messages',
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_LIST_MODELS: 'chat:list-models',
  CHAT_GET_SETTINGS: 'chat:get-settings',
  CHAT_PATCH_SETTINGS: 'chat:patch-settings',
  CHAT_SET_KEY: 'chat:set-key',
  CHAT_HAS_KEY: 'chat:has-key',
  CHAT_STREAM_CHUNK: 'chat:stream-chunk',
  CHAT_STREAM_DONE: 'chat:stream-done',
  CHAT_STREAM_ERROR: 'chat:stream-error',
```

- [ ] **Step 3: Extend the Tab union and FleetSettings**

In `src/shared/types.ts`, add `'chat'` to the `Tab.type` union (alongside `'sessions'`):

```ts
    | 'sessions'
    | 'chat';
```

In the same file, add `ai` to the `FleetSettings` type (after `kanban: KanbanSettings;`):

```ts
  ai: AiSettings;
```

Add the import at the top of `src/shared/types.ts`:

```ts
import type { AiSettings } from './chat-types';
```

- [ ] **Step 4: Add default settings**

In `src/shared/constants.ts`, import the default and add the `ai` branch to `DEFAULT_SETTINGS` (after the `kanban` branch):

```ts
import { DEFAULT_AI_SETTINGS } from './chat-types';
```

```ts
  ai: DEFAULT_AI_SETTINGS
```

- [ ] **Step 5: Register the Chat tool**

In `src/shared/tools.ts`:

```ts
export type ToolType = 'annotate' | 'kanban' | 'images' | 'sessions' | 'chat';
```

Add to `DEFAULT_TOOL_VISIBILITY`:

```ts
  chat: false
```

Add to `TOGGLEABLE_TOOLS` (end of the array):

```ts
  { type: 'chat', label: 'Chat', description: 'Chat with AI models via OpenRouter.' }
```

- [ ] **Step 6: Merge `ai` in the settings store**

In `src/main/settings-store.ts`, inside `get()`'s returned object, add (after the `kanban: {...}` block):

```ts
      ai: {
        ...DEFAULT_SETTINGS.ai,
        ...saved.ai,
        chat: { ...DEFAULT_SETTINGS.ai.chat, ...saved.ai?.chat }
      }
```

In `set()`'s merged object, add an analogous branch (after the existing nested merges):

```ts
      ai: {
        ...current.ai,
        ...(partial.ai ?? {}),
        chat: { ...current.ai.chat, ...(partial.ai?.chat ?? {}) }
      }
```

- [ ] **Step 7: Write the failing settings-merge test**

Create `src/main/__tests__/settings-store-ai.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { DEFAULT_CHAT_SETTINGS } from '../../shared/chat-types';

describe('AI settings defaults', () => {
  it('DEFAULT_SETTINGS carries the chat defaults', () => {
    expect(DEFAULT_SETTINGS.ai.chat).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(DEFAULT_SETTINGS.ai.chat.provider).toBe('openrouter');
    expect(DEFAULT_SETTINGS.ai.chat.defaultModel).toBe('anthropic/claude-3.5-sonnet');
  });
});
```

- [ ] **Step 8: Run the test and typecheck**

Run: `npx vitest run src/main/__tests__/settings-store-ai.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS (confirms the `ai` branch is wired through every settings type).

- [ ] **Step 9: Commit**

```bash
git add src/shared/chat-types.ts src/shared/ipc-channels.ts src/shared/types.ts src/shared/constants.ts src/shared/tools.ts src/main/settings-store.ts src/main/__tests__/settings-store-ai.test.ts
git commit -m "feat(chat): shared types, channels, settings, and tool registration"
```

---

## Task 2: OpenRouter client (SSE streaming + models)

Deliverable: `OpenRouterClient` with a pure, fully-tested SSE consumer and a model-list fetch. No IPC yet.

**Files:**
- Create: `src/main/chat/openrouter-client.ts`
- Test: `src/main/chat/__tests__/openrouter-client.test.ts`

**Interfaces:**
- Consumes: `ChatModel`, `ChatCompletionMessage` (Task 1).
- Produces:
  ```ts
  export async function consumeSSE(chunks: AsyncIterable<string>, onDelta: (d: string) => void): Promise<void>;
  export type StreamOpts = {
    apiKey: string; model: string; messages: ChatCompletionMessage[];
    signal: AbortSignal; onDelta: (delta: string) => void;
  };
  export class OpenRouterClient {
    constructor(fetchImpl?: typeof fetch);
    listModels(apiKey: string): Promise<ChatModel[]>;
    streamCompletion(opts: StreamOpts): Promise<void>; // resolves on [DONE]; throws Error on failure
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/main/chat/__tests__/openrouter-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { consumeSSE, OpenRouterClient } from '../openrouter-client';

async function* feed(lines: string[]): AsyncIterable<string> {
  // Emit in arbitrary chunk boundaries to exercise the line buffer.
  for (const l of lines) yield l;
}

describe('consumeSSE', () => {
  it('extracts delta content and stops at [DONE]', async () => {
    const out: string[] = [];
    await consumeSSE(
      feed([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        'data: [DONE]\n'
      ]),
      (d) => out.push(d)
    );
    expect(out.join('')).toBe('Hello');
  });

  it('ignores OpenRouter processing comments', async () => {
    const out: string[] = [];
    await consumeSSE(
      feed([': OPENROUTER PROCESSING\n', 'data: {"choices":[{"delta":{"content":"x"}}]}\n', 'data: [DONE]\n']),
      (d) => out.push(d)
    );
    expect(out.join('')).toBe('x');
  });

  it('handles deltas split across chunk boundaries', async () => {
    const out: string[] = [];
    await consumeSSE(feed(['data: {"choices":[{"delta":{"con', 'tent":"hi"}}]}\n', 'data: [DONE]\n']), (d) =>
      out.push(d)
    );
    expect(out.join('')).toBe('hi');
  });

  it('throws on a mid-stream error event (HTTP 200 body error)', async () => {
    await expect(
      consumeSSE(
        feed([
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
          'data: {"error":{"message":"rate limited"},"choices":[{"finish_reason":"error","delta":{}}]}\n'
        ]),
        () => {}
      )
    ).rejects.toThrow('rate limited');
  });
});

describe('OpenRouterClient.listModels', () => {
  it('normalizes /models into {id,name,contextLength}', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'a/b', name: 'B', context_length: 4096 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as unknown as typeof fetch;
    const client = new OpenRouterClient(fakeFetch);
    const models = await client.listModels('sk-test');
    expect(models).toEqual([{ id: 'a/b', name: 'B', contextLength: 4096 }]);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) })
    );
  });

  it('throws on non-200', async () => {
    const fakeFetch = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const client = new OpenRouterClient(fakeFetch);
    await expect(client.listModels('bad')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/chat/__tests__/openrouter-client.test.ts`
Expected: FAIL — "Cannot find module '../openrouter-client'".

- [ ] **Step 3: Implement the client**

Create `src/main/chat/openrouter-client.ts`:

```ts
import { z } from 'zod';
import type { ChatModel, ChatCompletionMessage } from '../../shared/chat-types';

const BASE = 'https://openrouter.ai/api/v1';
// App-attribution headers per OpenRouter convention.
const APP_HEADERS = { 'HTTP-Referer': 'https://github.com/khang859/fleet', 'X-Title': 'Fleet' };

const MODELS_SCHEMA = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().optional()
    })
  )
});

const DELTA_SCHEMA = z.object({
  error: z.object({ message: z.string() }).optional(),
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullish() }).optional() }))
    .optional()
});

/**
 * Parse an OpenRouter SSE stream. Calls onDelta for each content fragment.
 * Resolves when the [DONE] sentinel arrives. Throws if the body carries a
 * top-level `error` (OpenRouter delivers mid-stream errors with HTTP 200).
 */
export async function consumeSSE(
  chunks: AsyncIterable<string>,
  onDelta: (delta: string) => void
): Promise<void> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '' || line.startsWith(':')) continue; // blank or keep-alive comment
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      let parsed: z.infer<typeof DELTA_SCHEMA>;
      try {
        parsed = DELTA_SCHEMA.parse(JSON.parse(data));
      } catch {
        continue; // tolerate non-JSON / unexpected shapes
      }
      if (parsed.error) throw new Error(parsed.error.message);
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) onDelta(content);
    }
  }
}

export type StreamOpts = {
  apiKey: string;
  model: string;
  messages: ChatCompletionMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => void;
};

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async listModels(apiKey: string): Promise<ChatModel[]> {
    const res = await this.fetchImpl(`${BASE}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, ...APP_HEADERS }
    });
    if (!res.ok) throw new Error(`OpenRouter /models failed: ${res.status}`);
    const json = MODELS_SCHEMA.parse(await res.json());
    return json.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0
    }));
  }

  async streamCompletion(opts: StreamOpts): Promise<void> {
    const res = await this.fetchImpl(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
      signal: opts.signal
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenRouter request failed: ${res.status} ${detail}`.trim());
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    async function* iterate(): AsyncIterable<string> {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    await consumeSSE(iterate(), opts.onDelta);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/chat/__tests__/openrouter-client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/openrouter-client.ts src/main/chat/__tests__/openrouter-client.test.ts
git commit -m "feat(chat): OpenRouter client with SSE streaming and model list"
```

---

## Task 3: API-key secret store (safeStorage)

Deliverable: `ChatSecrets` storing the OpenRouter key encrypted, with injectable `store`/`safeStorage` for tests (mirrors `EnvSyncSecrets`).

**Files:**
- Create: `src/main/chat/chat-secrets.ts`
- Test: `src/main/chat/__tests__/chat-secrets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ChatSecrets {
    constructor(opts?: { store?: KeyStore; safeStorage?: SafeStorageLike });
    isEncryptionAvailable(): boolean;
    setKey(plain: string): void;
    getKey(): string | null;   // main-process only — never returned over IPC
    hasKey(): boolean;
    clearKey(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/chat/__tests__/chat-secrets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ChatSecrets } from '../chat-secrets';

function makeFakes() {
  let data: { keyEnc?: string } = {};
  const store = { get: () => data, set: (next: { keyEnc?: string }) => (data = next) };
  // Reversible fake "encryption": base64.
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (p: string) => Buffer.from(p, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  };
  return { store, safe };
}

describe('ChatSecrets', () => {
  it('round-trips a key through encryption', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    expect(s.hasKey()).toBe(false);
    s.setKey('sk-or-123');
    expect(s.hasKey()).toBe(true);
    expect(s.getKey()).toBe('sk-or-123');
  });

  it('clears the key', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    s.setKey('sk-or-123');
    s.clearKey();
    expect(s.hasKey()).toBe(false);
    expect(s.getKey()).toBeNull();
  });

  it('throws on setKey when encryption is unavailable', () => {
    const { store } = makeFakes();
    const safe = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(''),
      decryptString: () => ''
    };
    const s = new ChatSecrets({ store, safeStorage: safe });
    expect(() => s.setKey('x')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/chat/__tests__/chat-secrets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChatSecrets**

Create `src/main/chat/chat-secrets.ts`:

```ts
import Store from 'electron-store';
import { safeStorage } from 'electron';

type SecretsData = { keyEnc?: string };

interface KeyStore {
  get(): SecretsData;
  set(next: SecretsData): void;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

type Options = { store?: KeyStore; safeStorage?: SafeStorageLike };

function defaultStore(): KeyStore {
  const store = new Store<{ data: SecretsData }>({
    name: 'fleet-chat-secrets',
    defaults: { data: {} }
  });
  return {
    get: () => store.get('data'),
    set: (next) => store.set('data', next)
  };
}

export class ChatSecrets {
  private readonly store: KeyStore;
  private readonly safe: SafeStorageLike;

  constructor(opts: Options = {}) {
    this.store = opts.store ?? defaultStore();
    this.safe = opts.safeStorage ?? safeStorage;
  }

  isEncryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  setKey(plain: string): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }
    const enc = this.safe.encryptString(plain).toString('base64');
    this.store.set({ keyEnc: enc });
  }

  getKey(): string | null {
    const { keyEnc } = this.store.get();
    if (!keyEnc) return null;
    try {
      return this.safe.decryptString(Buffer.from(keyEnc, 'base64'));
    } catch {
      return null;
    }
  }

  hasKey(): boolean {
    return Boolean(this.store.get().keyEnc);
  }

  clearKey(): void {
    this.store.set({});
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/chat/__tests__/chat-secrets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/chat-secrets.ts src/main/chat/__tests__/chat-secrets.test.ts
git commit -m "feat(chat): safeStorage-encrypted API key store"
```

---

## Task 4: Conversation store (SQLite)

Deliverable: `ChatStore` with conversation + message CRUD and cascade delete, backed by `better-sqlite3`.

**Files:**
- Create: `src/main/chat/chat-store.ts`
- Test: `src/main/chat/__tests__/chat-store.test.ts`

**Interfaces:**
- Consumes: `ChatConversation`, `ChatMessage`, `ChatRole` (Task 1).
- Produces:
  ```ts
  export class ChatStore {
    constructor(dbPath: string);
    createConversation(input?: { title?: string; model?: string | null }): ChatConversation;
    listConversations(): ChatConversation[];          // newest updated first
    getConversation(id: string): ChatConversation | null;
    renameConversation(id: string, title: string): void;
    setConversationModel(id: string, model: string | null): void;
    deleteConversation(id: string): void;
    addMessage(input: { conversationId: string; role: ChatRole; content: string }): ChatMessage;
    getMessages(conversationId: string): ChatMessage[]; // oldest first
    close(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/chat/__tests__/chat-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';

const TEST_DIR = join(tmpdir(), `fleet-chat-store-test-${process.pid}`);
const DB_PATH = join(TEST_DIR, 'chat.db');

describe('ChatStore', () => {
  let store: ChatStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new ChatStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the db file', () => {
    expect(existsSync(DB_PATH)).toBe(true);
  });

  it('creates and lists conversations newest-first', () => {
    const a = store.createConversation({ title: 'First' });
    const b = store.createConversation({ title: 'Second' });
    store.renameConversation(a.id, 'First updated'); // bumps a.updatedAt
    const list = store.listConversations();
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(list[0].title).toBe('First updated');
    void b;
  });

  it('appends and reads messages oldest-first', () => {
    const c = store.createConversation();
    store.addMessage({ conversationId: c.id, role: 'user', content: 'hi' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'hello' });
    const msgs = store.getMessages(c.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']);
  });

  it('cascade-deletes messages with their conversation', () => {
    const c = store.createConversation();
    store.addMessage({ conversationId: c.id, role: 'user', content: 'hi' });
    store.deleteConversation(c.id);
    expect(store.getConversation(c.id)).toBeNull();
    expect(store.getMessages(c.id)).toEqual([]);
  });

  it('sets a per-conversation model override', () => {
    const c = store.createConversation();
    expect(c.model).toBeNull();
    store.setConversationModel(c.id, 'openai/gpt-4o');
    expect(store.getConversation(c.id)?.model).toBe('openai/gpt-4o');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/chat/__tests__/chat-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChatStore**

Create `src/main/chat/chat-store.ts`:

```ts
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { ChatConversation, ChatMessage, ChatRole } from '../../shared/chat-types';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'New chat',
  model       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
`;

type ConversationRow = {
  id: string;
  title: string;
  model: string | null;
  created_at: number;
  updated_at: number;
};
type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
};

function toConversation(r: ConversationRow): ChatConversation {
  return { id: r.id, title: r.title, model: r.model, createdAt: r.created_at, updatedAt: r.updated_at };
}
function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as ChatRole,
    content: r.content,
    createdAt: r.created_at
  };
}

export class ChatStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = wal');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  createConversation(input: { title?: string; model?: string | null } = {}): ChatConversation {
    const now = Date.now();
    const row: ConversationRow = {
      id: randomUUID(),
      title: input.title ?? 'New chat',
      model: input.model ?? null,
      created_at: now,
      updated_at: now
    };
    this.db
      .prepare('INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.title, row.model, row.created_at, row.updated_at);
    return toConversation(row);
  }

  listConversations(): ChatConversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all() as ConversationRow[];
    return rows.map(toConversation);
  }

  getConversation(id: string): ChatConversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : null;
  }

  renameConversation(id: string, title: string): void {
    this.db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  setConversationModel(id: string, model: string | null): void {
    this.db
      .prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?')
      .run(model, Date.now(), id);
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  addMessage(input: { conversationId: string; role: ChatRole; content: string }): ChatMessage {
    const now = Date.now();
    const row: MessageRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      created_at: now
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(row.id, row.conversation_id, row.role, row.content, row.created_at);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId);
    return toMessage(row);
  }

  getMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as MessageRow[];
    return rows.map(toMessage);
  }

  close(): void {
    this.db.close();
  }
}
```

Note: the `as ConversationRow[]` / `as ChatRole` casts here are on `better-sqlite3` return values and mirror the existing `kanban-store.ts` convention for DB rows. If the project lint forbids them in `src/`, wrap reads in a small zod schema as `kanban-store.ts` does for `verify_commands`; otherwise the row-cast convention is accepted for DB layers.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/chat/__tests__/chat-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run lint to confirm DB casts are acceptable**

Run: `npm run lint`
Expected: PASS. If the row casts are flagged, replace each `.all()/.get()` cast with a zod `.parse()` of the row (pattern: define `ConversationRowSchema`/`MessageRowSchema` with `z.object`, parse each row) and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/main/chat/chat-store.ts src/main/chat/__tests__/chat-store.test.ts
git commit -m "feat(chat): SQLite conversation and message store"
```

---

## Task 5: Chat service + IPC + preload + main wiring

Deliverable: `ChatService` orchestrates send→stream→persist→events; `registerChatIpc` exposes all channels; preload exposes `window.fleet.chat`; main process constructs and wires everything. Streaming is verified by a service unit test with mocks.

**Files:**
- Create: `src/main/chat/chat-service.ts`
- Create: `src/main/chat/chat-ipc.ts`
- Modify: `src/main/index.ts` (construct deps; call `registerChatIpc`)
- Modify: `src/preload/index.ts` (`chat` block on `fleetApi`)
- Test: `src/main/chat/__tests__/chat-service.test.ts`

**Interfaces:**
- Consumes: `OpenRouterClient` (Task 2), `ChatSecrets` (Task 3), `ChatStore` (Task 4), settings store (Task 1).
- Produces:
  ```ts
  export type ChatEmitter = (channel: string, payload: unknown) => void;
  export class ChatService {
    constructor(deps: {
      store: ChatStore; client: OpenRouterClient; secrets: ChatSecrets;
      getDefaultModel: () => string; emit: ChatEmitter;
    });
    send(req: ChatSendRequest): ChatSendResponse;   // returns immediately; streams async
    cancel(streamId: string): void;
    listModels(): Promise<ChatModel[]>;
  }
  export function registerChatIpc(deps: {
    store: ChatStore; secrets: ChatSecrets; service: ChatService;
    settingsStore: SettingsStore; emit-less — uses ipcMain
  }): void;
  ```
- Preload produces `window.fleet.chat` (see Step 6).

- [ ] **Step 1: Write the failing service test**

Create `src/main/chat/__tests__/chat-service.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';
import { ChatSecrets } from '../chat-secrets';
import { OpenRouterClient } from '../openrouter-client';
import { ChatService } from '../chat-service';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

const DIR = join(tmpdir(), `fleet-chat-service-test-${process.pid}`);

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

describe('ChatService.send', () => {
  it('persists the user message, streams deltas, then persists the assistant message', async () => {
    mkdirSync(DIR, { recursive: true });
    const store = new ChatStore(join(DIR, 'chat.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    // Stub streamCompletion to emit two deltas then resolve.
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      opts.onDelta('Hel');
      opts.onDelta('lo');
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'anthropic/claude-3.5-sonnet',
      emit: (channel, payload) => events.push({ channel, payload })
    });

    const res = service.send({ conversationId: conv.id, text: 'hi', model: 'x/y' });
    expect(res.userMessage.content).toBe('hi');
    // Let the async streaming microtasks flush.
    await vi.waitFor(() => {
      expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_DONE)).toBe(true);
    });

    const chunks = events.filter((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_CHUNK);
    expect(chunks.length).toBe(2);
    const msgs = store.getMessages(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('Hello');
    store.close();
    rmSync(DIR, { recursive: true, force: true });
  });

  it('emits stream-error with the partial text on failure', async () => {
    mkdirSync(DIR, { recursive: true });
    const store = new ChatStore(join(DIR, 'chat2.db'));
    const conv = store.createConversation();
    const client = new OpenRouterClient();
    vi.spyOn(client, 'streamCompletion').mockImplementation(async (opts) => {
      opts.onDelta('part');
      throw new Error('boom');
    });
    const events: Array<{ channel: string; payload: unknown }> = [];
    const service = new ChatService({
      store,
      client,
      secrets: fakeSecrets(),
      getDefaultModel: () => 'm',
      emit: (channel, payload) => events.push({ channel, payload })
    });
    service.send({ conversationId: conv.id, text: 'hi', model: 'x/y' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_ERROR)).toBe(true);
    });
    const err = events.find((e) => e.channel === IPC_CHANNELS.CHAT_STREAM_ERROR);
    expect((err?.payload as { partial: string }).partial).toBe('part');
    store.close();
    rmSync(DIR, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/chat/__tests__/chat-service.test.ts`
Expected: FAIL — "Cannot find module '../chat-service'".

- [ ] **Step 3: Implement ChatService**

Create `src/main/chat/chat-service.ts`:

```ts
import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type {
  ChatSendRequest,
  ChatSendResponse,
  ChatModel,
  ChatCompletionMessage,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload
} from '../../shared/chat-types';
import type { ChatStore } from './chat-store';
import type { ChatSecrets } from './chat-secrets';
import type { OpenRouterClient } from './openrouter-client';

export type ChatEmitter = (channel: string, payload: unknown) => void;

type Deps = {
  store: ChatStore;
  client: OpenRouterClient;
  secrets: ChatSecrets;
  getDefaultModel: () => string;
  emit: ChatEmitter;
};

export class ChatService {
  private readonly deps: Deps;
  private readonly inflight = new Map<string, AbortController>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  send(req: ChatSendRequest): ChatSendResponse {
    const { store, secrets, client, getDefaultModel, emit } = this.deps;
    const userMessage = store.addMessage({
      conversationId: req.conversationId,
      role: 'user',
      content: req.text
    });
    const streamId = randomUUID();
    const controller = new AbortController();
    this.inflight.set(streamId, controller);

    const apiKey = secrets.getKey();
    const model = req.model || getDefaultModel();
    const history: ChatCompletionMessage[] = store
      .getMessages(req.conversationId)
      .map((m) => ({ role: m.role, content: m.content }));

    void (async () => {
      let partial = '';
      try {
        if (!apiKey) throw new Error('No OpenRouter API key configured');
        await client.streamCompletion({
          apiKey,
          model,
          messages: history,
          signal: controller.signal,
          onDelta: (delta) => {
            partial += delta;
            emit(IPC_CHANNELS.CHAT_STREAM_CHUNK, { streamId, delta } satisfies ChatStreamChunkPayload);
          }
        });
        const message = store.addMessage({
          conversationId: req.conversationId,
          role: 'assistant',
          content: partial
        });
        emit(IPC_CHANNELS.CHAT_STREAM_DONE, { streamId, message } satisfies ChatStreamDonePayload);
      } catch (err) {
        // Persist whatever streamed so the conversation isn't lost.
        if (partial) {
          store.addMessage({ conversationId: req.conversationId, role: 'assistant', content: partial });
        }
        emit(IPC_CHANNELS.CHAT_STREAM_ERROR, {
          streamId,
          message: err instanceof Error ? err.message : String(err),
          partial
        } satisfies ChatStreamErrorPayload);
      } finally {
        this.inflight.delete(streamId);
      }
    })();

    return { streamId, userMessage };
  }

  cancel(streamId: string): void {
    this.inflight.get(streamId)?.abort();
    this.inflight.delete(streamId);
  }

  async listModels(): Promise<ChatModel[]> {
    const key = this.deps.secrets.getKey();
    if (!key) throw new Error('No OpenRouter API key configured');
    return this.deps.client.listModels(key);
  }
}
```

- [ ] **Step 4: Run the service test to verify it passes**

Run: `npx vitest run src/main/chat/__tests__/chat-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the IPC registration**

Create `src/main/chat/chat-ipc.ts`:

```ts
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ChatSendRequest, ChatSettings, ChatConversation, ChatMessage, ChatModel } from '../../shared/chat-types';
import type { ChatStore } from './chat-store';
import type { ChatSecrets } from './chat-secrets';
import type { ChatService } from './chat-service';
import type { SettingsStore } from '../settings-store';

type Deps = {
  store: ChatStore;
  secrets: ChatSecrets;
  service: ChatService;
  settingsStore: SettingsStore;
};

export function registerChatIpc(deps: Deps): void {
  const { store, secrets, service, settingsStore } = deps;

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS, (): ChatConversation[] =>
    store.listConversations()
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_CREATE_CONVERSATION, (): ChatConversation =>
    store.createConversation()
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_RENAME_CONVERSATION, (_e, req: { id: string; title: string }) => {
    store.renameConversation(req.id, req.title);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, (_e, id: string) => {
    store.deleteConversation(id);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_MESSAGES, (_e, conversationId: string): ChatMessage[] =>
    store.getMessages(conversationId)
  );
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, (_e, req: ChatSendRequest) => service.send(req));
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL, (_e, streamId: string) => {
    service.cancel(streamId);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_MODELS, (): Promise<ChatModel[]> => service.listModels());

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_SETTINGS, (): ChatSettings => settingsStore.get().ai.chat);
  ipcMain.handle(IPC_CHANNELS.CHAT_PATCH_SETTINGS, (_e, patch: Partial<ChatSettings>) => {
    settingsStore.set({ ai: { chat: { ...settingsStore.get().ai.chat, ...patch } } });
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_KEY, (_e, key: string) => {
    secrets.setKey(key);
  });
  ipcMain.handle(IPC_CHANNELS.CHAT_HAS_KEY, (): boolean => secrets.hasKey());
}
```

Note: `CHAT_PATCH_SETTINGS` constructs the `FleetSettingsPatch` with a nested `ai.chat` partial. Confirm `FleetSettingsPatch` allows a partial `ai` branch — it is a deep-partial of `FleetSettings`, so `{ ai: { chat: {...} } }` typechecks. If `FleetSettingsPatch` is hand-written and lacks `ai`, add `ai?: { chat?: Partial<ChatSettings> }` to it in `src/shared/types.ts`.

- [ ] **Step 6: Expose `chat` in preload**

In `src/preload/index.ts`, add a `chat` block to the `fleetApi` object (alongside `kanban`). Use the existing `typedInvoke` and `onChannel` helpers:

```ts
  chat: {
    listConversations: async (): Promise<ChatConversation[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS),
    createConversation: async (): Promise<ChatConversation> =>
      typedInvoke(IPC_CHANNELS.CHAT_CREATE_CONVERSATION),
    renameConversation: async (id: string, title: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_RENAME_CONVERSATION, { id, title }),
    deleteConversation: async (id: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, id),
    getMessages: async (conversationId: string): Promise<ChatMessage[]> =>
      typedInvoke(IPC_CHANNELS.CHAT_GET_MESSAGES, conversationId),
    send: async (req: ChatSendRequest): Promise<ChatSendResponse> =>
      typedInvoke(IPC_CHANNELS.CHAT_SEND, req),
    cancel: async (streamId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_CANCEL, streamId),
    listModels: async (): Promise<ChatModel[]> => typedInvoke(IPC_CHANNELS.CHAT_LIST_MODELS),
    getSettings: async (): Promise<ChatSettings> => typedInvoke(IPC_CHANNELS.CHAT_GET_SETTINGS),
    patchSettings: async (patch: Partial<ChatSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.CHAT_PATCH_SETTINGS, patch),
    setKey: async (key: string): Promise<void> => typedInvoke(IPC_CHANNELS.CHAT_SET_KEY, key),
    hasKey: async (): Promise<boolean> => typedInvoke(IPC_CHANNELS.CHAT_HAS_KEY),
    onStreamChunk: (cb: (p: ChatStreamChunkPayload) => void): Unsubscribe =>
      onChannel<ChatStreamChunkPayload>(IPC_CHANNELS.CHAT_STREAM_CHUNK, cb),
    onStreamDone: (cb: (p: ChatStreamDonePayload) => void): Unsubscribe =>
      onChannel<ChatStreamDonePayload>(IPC_CHANNELS.CHAT_STREAM_DONE, cb),
    onStreamError: (cb: (p: ChatStreamErrorPayload) => void): Unsubscribe =>
      onChannel<ChatStreamErrorPayload>(IPC_CHANNELS.CHAT_STREAM_ERROR, cb)
  },
```

Add the type imports at the top of `src/preload/index.ts`:

```ts
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatSettings,
  ChatSendRequest,
  ChatSendResponse,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload
} from '../shared/chat-types';
```

- [ ] **Step 7: Construct and wire the chat deps in main**

In `src/main/index.ts`: import the modules, resolve the DB path with `app.getPath('userData')`, construct the four objects, and register the IPC. Place construction near the other store/service constructions, and the `registerChatIpc(...)` call near the other `register*Ipc(...)` calls.

```ts
import { join } from 'path';
import { app } from 'electron';
import { ChatStore } from './chat/chat-store';
import { ChatSecrets } from './chat/chat-secrets';
import { OpenRouterClient } from './chat/openrouter-client';
import { ChatService } from './chat/chat-service';
import { registerChatIpc } from './chat/chat-ipc';
```

```ts
const chatStore = new ChatStore(join(app.getPath('userData'), 'chat.db'));
const chatSecrets = new ChatSecrets();
const chatClient = new OpenRouterClient();
const chatService = new ChatService({
  store: chatStore,
  client: chatClient,
  secrets: chatSecrets,
  getDefaultModel: () => settingsStore.get().ai.chat.defaultModel,
  emit: (channel, payload) => {
    const w = getMainWindow(); // use whatever accessor index.ts already has for the BrowserWindow
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
});
registerChatIpc({ store: chatStore, secrets: chatSecrets, service: chatService, settingsStore });
```

Adapt `getMainWindow()` / `settingsStore` to the exact identifiers already present in `index.ts` (the file already holds a `BrowserWindow` accessor and a `SettingsStore` instance — reuse them).

- [ ] **Step 8: Typecheck, lint, and run chat tests**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run lint`
Expected: PASS.
Run: `npx vitest run src/main/chat`
Expected: PASS (all chat main-process tests).

- [ ] **Step 9: Commit**

```bash
git add src/main/chat/chat-service.ts src/main/chat/chat-ipc.ts src/main/chat/__tests__/chat-service.test.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(chat): chat service, IPC handlers, preload bridge, and main wiring"
```

---

## Task 6: Renderer chat store (Zustand)

Deliverable: a Zustand store that drives the UI — loads conversations/messages/models, sends with an optimistic echo, and applies streaming events. Verified with a focused store test (mocked `window.fleet.chat`).

**Files:**
- Create: `src/renderer/src/store/chat-store.ts`
- Test: `src/renderer/src/store/__tests__/chat-store.test.ts`

**Interfaces:**
- Consumes: `window.fleet.chat` (Task 5).
- Produces:
  ```ts
  type ChatStatus = 'idle' | 'streaming' | 'error';
  useChatStore: {
    conversations: ChatConversation[]; activeId: string | null;
    messages: ChatMessage[]; streamingText: string | null; streamId: string | null;
    models: ChatModel[]; keyPresent: boolean; status: ChatStatus; error: string | null;
    init(): Promise<void>;            // load conversations + key presence + subscribe to events
    selectConversation(id: string): Promise<void>;
    newConversation(): Promise<void>;
    deleteConversation(id: string): Promise<void>;
    renameConversation(id: string, title: string): Promise<void>;
    send(text: string, model: string): Promise<void>;
    cancel(): void;
    loadModels(): Promise<void>;
    refreshKeyPresence(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing store test**

Create `src/renderer/src/store/__tests__/chat-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../chat-store';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';

type Listener = (p: unknown) => void;
const listeners = new Map<string, Listener>();

beforeEach(() => {
  listeners.clear();
  const fleet = {
    chat: {
      listConversations: vi.fn(async () => [{ id: 'c1', title: 'New chat', model: null, createdAt: 1, updatedAt: 1 }]),
      createConversation: vi.fn(async () => ({ id: 'c2', title: 'New chat', model: null, createdAt: 2, updatedAt: 2 })),
      renameConversation: vi.fn(async () => {}),
      deleteConversation: vi.fn(async () => {}),
      getMessages: vi.fn(async () => []),
      send: vi.fn(async () => ({ streamId: 's1', userMessage: { id: 'm1', conversationId: 'c1', role: 'user', content: 'hi', createdAt: 3 } })),
      cancel: vi.fn(async () => {}),
      listModels: vi.fn(async () => [{ id: 'x/y', name: 'Y', contextLength: 4096 }]),
      getSettings: vi.fn(async () => ({ provider: 'openrouter', defaultModel: 'x/y' })),
      patchSettings: vi.fn(async () => {}),
      setKey: vi.fn(async () => {}),
      hasKey: vi.fn(async () => true),
      onStreamChunk: (cb: Listener) => { listeners.set(IPC_CHANNELS.CHAT_STREAM_CHUNK, cb); return () => {}; },
      onStreamDone: (cb: Listener) => { listeners.set(IPC_CHANNELS.CHAT_STREAM_DONE, cb); return () => {}; },
      onStreamError: (cb: Listener) => { listeners.set(IPC_CHANNELS.CHAT_STREAM_ERROR, cb); return () => {}; }
    }
  };
  (globalThis as unknown as { window: { fleet: typeof fleet } }).window = { fleet };
  useChatStore.setState({
    conversations: [], activeId: 'c1', messages: [], streamingText: null, streamId: null,
    models: [], keyPresent: false, status: 'idle', error: null
  });
});

describe('useChatStore', () => {
  it('send appends an optimistic user message and enters streaming', async () => {
    await useChatStore.getState().send('hi', 'x/y');
    const s = useChatStore.getState();
    expect(s.messages.at(-1)?.content).toBe('hi');
    expect(s.status).toBe('streaming');
    expect(s.streamId).toBe('s1');
  });

  it('applies chunk then done events', async () => {
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'Hel' });
    listeners.get(IPC_CHANNELS.CHAT_STREAM_CHUNK)?.({ streamId: 's1', delta: 'lo' });
    expect(useChatStore.getState().streamingText).toBe('Hello');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_DONE)?.({
      streamId: 's1',
      message: { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Hello', createdAt: 4 }
    });
    const s = useChatStore.getState();
    expect(s.status).toBe('idle');
    expect(s.streamingText).toBeNull();
    expect(s.messages.at(-1)?.content).toBe('Hello');
  });

  it('applies an error event with partial text', async () => {
    await useChatStore.getState().send('hi', 'x/y');
    listeners.get(IPC_CHANNELS.CHAT_STREAM_ERROR)?.({ streamId: 's1', message: 'boom', partial: 'part' });
    const s = useChatStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/chat-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `src/renderer/src/store/chat-store.ts`:

```ts
import { create } from 'zustand';
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatStreamChunkPayload,
  ChatStreamDonePayload,
  ChatStreamErrorPayload
} from '../../../shared/chat-types';

type ChatStatus = 'idle' | 'streaming' | 'error';

type ChatStoreState = {
  conversations: ChatConversation[];
  activeId: string | null;
  messages: ChatMessage[];
  streamingText: string | null;
  streamId: string | null;
  models: ChatModel[];
  keyPresent: boolean;
  status: ChatStatus;
  error: string | null;

  init: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  send: (text: string, model: string) => Promise<void>;
  cancel: () => void;
  loadModels: () => Promise<void>;
  refreshKeyPresence: () => Promise<void>;
};

let subscribed = false;

export const useChatStore = create<ChatStoreState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  streamingText: null,
  streamId: null,
  models: [],
  keyPresent: false,
  status: 'idle',
  error: null,

  init: async () => {
    if (!subscribed) {
      subscribed = true;
      window.fleet.chat.onStreamChunk((p: ChatStreamChunkPayload) => {
        if (p.streamId !== get().streamId) return;
        set((s) => ({ streamingText: (s.streamingText ?? '') + p.delta }));
      });
      window.fleet.chat.onStreamDone((p: ChatStreamDonePayload) => {
        if (p.streamId !== get().streamId) return;
        set((s) => ({
          messages: [...s.messages, p.message],
          streamingText: null,
          streamId: null,
          status: 'idle'
        }));
      });
      window.fleet.chat.onStreamError((p: ChatStreamErrorPayload) => {
        if (p.streamId !== get().streamId) return;
        set({ status: 'error', error: p.message, streamingText: null, streamId: null });
      });
    }
    const conversations = await window.fleet.chat.listConversations();
    set({ conversations });
    await get().refreshKeyPresence();
    const first = conversations[0]?.id ?? null;
    if (first) await get().selectConversation(first);
  },

  selectConversation: async (id) => {
    set({ activeId: id, messages: [], streamingText: null, streamId: null, status: 'idle', error: null });
    const messages = await window.fleet.chat.getMessages(id);
    if (get().activeId !== id) return; // switched mid-load
    set({ messages });
  },

  newConversation: async () => {
    const conv = await window.fleet.chat.createConversation();
    set((s) => ({ conversations: [conv, ...s.conversations] }));
    await get().selectConversation(conv.id);
  },

  deleteConversation: async (id) => {
    await window.fleet.chat.deleteConversation(id);
    const remaining = get().conversations.filter((c) => c.id !== id);
    set({ conversations: remaining });
    if (get().activeId === id) {
      const next = remaining[0]?.id ?? null;
      if (next) await get().selectConversation(next);
      else set({ activeId: null, messages: [] });
    }
  },

  renameConversation: async (id, title) => {
    await window.fleet.chat.renameConversation(id, title);
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)) }));
  },

  send: async (text, model) => {
    const activeId = get().activeId;
    if (!activeId) return;
    const res = await window.fleet.chat.send({ conversationId: activeId, text, model });
    set((s) => ({
      messages: [...s.messages, res.userMessage],
      streamId: res.streamId,
      streamingText: '',
      status: 'streaming',
      error: null
    }));
  },

  cancel: () => {
    const id = get().streamId;
    if (id) void window.fleet.chat.cancel(id);
    set({ status: 'idle', streamId: null });
  },

  loadModels: async () => {
    const models = await window.fleet.chat.listModels();
    set({ models });
  },

  refreshKeyPresence: async () => {
    const keyPresent = await window.fleet.chat.hasKey();
    set({ keyPresent });
  }
}));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/store/__tests__/chat-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/chat-store.ts src/renderer/src/store/__tests__/chat-store.test.ts
git commit -m "feat(chat): renderer Zustand store with streaming event handling"
```

---

## Task 7: Chat view UI (rail, messages, composer, model picker)

Deliverable: the chat conversation experience renders and works against the store. No tab wiring yet (next task adds the shell + settings). Verified by typecheck/build (no renderer component-test harness exists in the repo) and a manual smoke note.

**Files:**
- Create: `src/renderer/src/components/chat/ConversationList.tsx`
- Create: `src/renderer/src/components/chat/MessageList.tsx`
- Create: `src/renderer/src/components/chat/Composer.tsx`
- Create: `src/renderer/src/components/chat/ModelPicker.tsx`
- Create: `src/renderer/src/components/chat/ChatView.tsx`

**Interfaces:**
- Consumes: `useChatStore` (Task 6).
- Produces: `<ChatView />` (default export-style named export used by Task 8).

- [ ] **Step 1: ConversationList**

Create `src/renderer/src/components/chat/ConversationList.tsx`:

```tsx
import { Plus, Trash2 } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';

export function ConversationList(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const select = useChatStore((s) => s.selectConversation);
  const create = useChatStore((s) => s.newConversation);
  const remove = useChatStore((s) => s.deleteConversation);

  return (
    <div className="flex h-full w-56 flex-col border-r border-fleet-border bg-fleet-surface">
      <button
        onClick={() => void create()}
        className="m-2 flex items-center gap-2 rounded bg-fleet-surface-2 px-3 py-1.5 text-sm text-fleet-text hover:bg-fleet-surface-3"
      >
        <Plus size={14} /> New chat
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => void select(c.id)}
            className={`group flex cursor-pointer items-center justify-between px-3 py-2 text-sm ${
              c.id === activeId ? 'bg-fleet-surface-2 text-fleet-text' : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
            }`}
          >
            <span className="truncate">{c.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void remove(c.id);
              }}
              className="opacity-0 group-hover:opacity-100"
            >
              <Trash2 size={13} className="text-fleet-text-muted hover:text-fleet-text" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: MessageList (markdown rendering)**

Create `src/renderer/src/components/chat/MessageList.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useChatStore } from '../../store/chat-store';

function Bubble({ role, content }: { role: string; content: string }): React.JSX.Element {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-4 py-2`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-fleet-accent/20 text-fleet-text' : 'bg-fleet-surface-2 text-fleet-text'
        }`}
      >
        <div className="prose prose-invert max-w-none prose-pre:bg-fleet-surface-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true }]]}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

export function MessageList(): React.JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const streamingText = useChatStore((s) => s.streamingText);
  const status = useChatStore((s) => s.status);
  const error = useChatStore((s) => s.error);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {messages.map((m) => (
        <Bubble key={m.id} role={m.role} content={m.content} />
      ))}
      {streamingText !== null && <Bubble role="assistant" content={streamingText || '…'} />}
      {status === 'error' && (
        <div className="px-4 py-2 text-sm text-red-400">Error: {error}</div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 3: ModelPicker (searchable dropdown)**

Create `src/renderer/src/components/chat/ModelPicker.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';

type Props = { value: string; onChange: (modelId: string) => void };

export function ModelPicker({ value, onChange }: Props): React.JSX.Element {
  const models = useChatStore((s) => s.models);
  const loadModels = useChatStore((s) => s.loadModels);
  const keyPresent = useChatStore((s) => s.keyPresent);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (keyPresent && models.length === 0) void loadModels();
  }, [keyPresent, models.length, loadModels]);

  const filtered = models.filter(
    (m) => m.id.toLowerCase().includes(query.toLowerCase()) || m.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => setQuery((q) => (e.key.length === 1 ? q + e.key : q))}
      className="rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text"
    >
      {value && !filtered.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {filtered.slice(0, 200).map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({Math.round(m.contextLength / 1000)}k)
        </option>
      ))}
    </select>
  );
}
```

Note: this uses a native `<select>` for v1 simplicity (search is best-effort). A Radix combobox can replace it later without changing the `value`/`onChange` contract.

- [ ] **Step 4: Composer**

Create `src/renderer/src/components/chat/Composer.tsx`:

```tsx
import { useState } from 'react';
import { Send, Square } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';

type Props = { defaultModel: string };

export function Composer({ defaultModel }: Props): React.JSX.Element {
  const [text, setText] = useState('');
  const [model, setModel] = useState(defaultModel);
  const status = useChatStore((s) => s.status);
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const streaming = status === 'streaming';

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    void send(trimmed, model);
    setText('');
  };

  return (
    <div className="border-t border-fleet-border p-2">
      <div className="mb-1 flex items-center gap-2">
        <ModelPicker value={model} onChange={setModel} />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message…"
          rows={2}
          className="min-h-0 flex-1 resize-none rounded border border-fleet-border bg-fleet-surface-2 px-3 py-2 text-sm text-fleet-text outline-none focus:border-fleet-border-strong"
        />
        {streaming ? (
          <button onClick={cancel} className="rounded bg-fleet-surface-3 p-2 text-fleet-text">
            <Square size={16} />
          </button>
        ) : (
          <button onClick={submit} className="rounded bg-fleet-accent/80 p-2 text-white hover:bg-fleet-accent">
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: ChatView (compose + no-key banner)**

Create `src/renderer/src/components/chat/ChatView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ConversationList } from './ConversationList';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

type Props = { onOpenSettings: () => void };

export function ChatView({ onOpenSettings }: Props): React.JSX.Element {
  const init = useChatStore((s) => s.init);
  const keyPresent = useChatStore((s) => s.keyPresent);
  const activeId = useChatStore((s) => s.activeId);
  const [defaultModel, setDefaultModel] = useState('anthropic/claude-3.5-sonnet');

  useEffect(() => {
    void init();
    void window.fleet.chat.getSettings().then((s) => setDefaultModel(s.defaultModel));
  }, [init]);

  return (
    <div className="flex h-full">
      <ConversationList />
      <div className="flex min-w-0 flex-1 flex-col">
        {!keyPresent && (
          <div className="flex items-center justify-between gap-3 border-b border-fleet-border bg-fleet-surface-2 px-4 py-2 text-sm text-fleet-text-secondary">
            <span>Add your OpenRouter API key to start chatting.</span>
            <button onClick={onOpenSettings} className="rounded bg-fleet-accent/80 px-3 py-1 text-white">
              Open Settings
            </button>
          </div>
        )}
        {activeId ? (
          <>
            <MessageList />
            <Composer defaultModel={defaultModel} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-fleet-text-muted">
            Start a new chat from the left.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/chat/ConversationList.tsx src/renderer/src/components/chat/MessageList.tsx src/renderer/src/components/chat/ModelPicker.tsx src/renderer/src/components/chat/Composer.tsx src/renderer/src/components/chat/ChatView.tsx
git commit -m "feat(chat): conversation list, message list, composer, and model picker UI"
```

---

## Task 8: Settings view + ChatTab shell

Deliverable: the in-tool Settings view (API key + default model) and the `ChatTab` shell with the Chat/Settings switcher (mirrors `SessionsTab`).

**Files:**
- Create: `src/renderer/src/components/chat/ChatSettingsView.tsx`
- Create: `src/renderer/src/components/chat/ChatTab.tsx`

**Interfaces:**
- Consumes: `useChatStore` (Task 6), `<ChatView/>` (Task 7).
- Produces: `<ChatTab />` (used by Task 9).

- [ ] **Step 1: ChatSettingsView (section-based, extensible)**

Create `src/renderer/src/components/chat/ChatSettingsView.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-b border-fleet-border px-5 py-4">
      <h3 className="mb-2 text-sm font-medium text-fleet-text">{title}</h3>
      {children}
    </div>
  );
}

export function ChatSettingsView(): React.JSX.Element {
  const keyPresent = useChatStore((s) => s.keyPresent);
  const refreshKeyPresence = useChatStore((s) => s.refreshKeyPresence);
  const loadModels = useChatStore((s) => s.loadModels);
  const [keyInput, setKeyInput] = useState('');
  const [defaultModel, setDefaultModel] = useState('anthropic/claude-3.5-sonnet');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => setDefaultModel(s.defaultModel));
  }, []);

  const saveKey = async (): Promise<void> => {
    if (!keyInput.trim()) return;
    await window.fleet.chat.setKey(keyInput.trim());
    setKeyInput('');
    await refreshKeyPresence();
    await loadModels();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const saveModel = async (modelId: string): Promise<void> => {
    setDefaultModel(modelId);
    await window.fleet.chat.patchSettings({ defaultModel: modelId });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="OpenRouter API Key">
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={keyPresent ? '•••••••• (saved)' : 'sk-or-…'}
            className="flex-1 rounded border border-fleet-border bg-fleet-surface-2 px-3 py-1.5 text-sm text-fleet-text outline-none"
          />
          <button onClick={() => void saveKey()} className="rounded bg-fleet-accent/80 px-3 py-1.5 text-sm text-white">
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-fleet-text-muted">
          {saved ? 'Saved ✓' : keyPresent ? 'A key is stored (encrypted).' : 'Not set.'}
        </p>
      </Section>
      <Section title="Default Model">
        <ModelPicker value={defaultModel} onChange={(m) => void saveModel(m)} />
        <p className="mt-1 text-xs text-fleet-text-muted">Used for new conversations.</p>
      </Section>
    </div>
  );
}
```

- [ ] **Step 2: ChatTab (shell + view switcher)**

Create `src/renderer/src/components/chat/ChatTab.tsx`:

```tsx
import { useState } from 'react';
import { MessageSquare, Settings } from 'lucide-react';
import { ChatView } from './ChatView';
import { ChatSettingsView } from './ChatSettingsView';

type View = 'chat' | 'settings';

export function ChatTab(): React.JSX.Element {
  const [view, setView] = useState<View>('chat');

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-fleet-border px-3 py-1.5">
        <button
          onClick={() => setView('chat')}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            view === 'chat' ? 'bg-fleet-surface-2 text-fleet-text' : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
          }`}
        >
          <MessageSquare size={14} /> Chat
        </button>
        <button
          onClick={() => setView('settings')}
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            view === 'settings' ? 'bg-fleet-surface-2 text-fleet-text' : 'text-fleet-text-secondary hover:bg-fleet-surface-2'
          }`}
        >
          <Settings size={14} /> Settings
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'chat' ? <ChatView onOpenSettings={() => setView('settings')} /> : <ChatSettingsView />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/chat/ChatSettingsView.tsx src/renderer/src/components/chat/ChatTab.tsx
git commit -m "feat(chat): in-tool settings view and ChatTab shell"
```

---

## Task 9: App, sidebar, and tool wiring

Deliverable: enabling the Chat tool pins a Chat tab; the tab renders `<ChatTab/>`; the mini-sidebar shows a Chat icon. End-to-end manual smoke confirms a real OpenRouter chat streams.

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts` (`ensureChatTab`)
- Modify: `src/renderer/src/App.tsx` (tab routing + pinned icon)
- Modify: `src/renderer/src/components/Sidebar.tsx` (Tools section — follows `TOGGLEABLE_TOOLS`, mechanical)

**Interfaces:**
- Consumes: `<ChatTab/>` (Task 8), `ensureSessionsTab` pattern (existing).

- [ ] **Step 1: Add `ensureChatTab`**

In `src/renderer/src/store/workspace-store.ts`, add next to `ensureSessionsTab`:

```ts
/** Ensure workspace has a pinned Chat tab; returns the workspace */
function ensureChatTab(workspace: Workspace): Workspace {
  if (workspace.tabs.some((t) => t.type === 'chat')) return workspace;
  const cwd = workspace.tabs[0]?.cwd ?? '/';
  const chatTab: Tab = {
    id: generateId(),
    label: 'Chat',
    labelIsCustom: true,
    cwd,
    type: 'chat',
    splitRoot: createLeaf(cwd)
  };
  return { ...workspace, tabs: [chatTab, ...workspace.tabs] };
}
```

Then wire it wherever `ensureSessionsTab`/`ensureKanbanTab` are invoked from the tool-visibility reconciliation (search the file for `ensureSessionsTab(` and add a parallel `if (toolVisibility.chat) ws = ensureChatTab(ws)` branch in the same place; mirror exactly how `sessions` is gated). Also add the inverse removal if the codebase removes tool tabs when toggled off (mirror the `sessions` removal path if present).

- [ ] **Step 2: Route the tab to `<ChatTab/>`**

In `src/renderer/src/App.tsx`, import the component near the other tab imports:

```ts
import { ChatTab } from './components/chat/ChatTab';
```

In the tab-content conditional (around the `tab.type === 'sessions' ? <SessionsTab /> :` line), add a branch before the final `<PaneGrid …>` fallback:

```tsx
                    ) : tab.type === 'chat' ? (
                      <ChatTab />
```

- [ ] **Step 3: Add the pinned mini-sidebar icon**

In `src/renderer/src/App.tsx`, in the pinned-tools section: (a) add `|| t.type === 'chat'` to the divider visibility check (the `workspace.tabs.some(...)` test), and (b) add a Chat icon block mirroring the Sessions block:

```tsx
            {/* Chat pinned icon */}
            {workspace.tabs
              .filter((t) => t.type === 'chat')
              .map((tab) => {
                const isChatActive = tab.id === activeTabId;
                return (
                  <MiniSidebarTooltip label="Chat" key={tab.id}>
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`p-1.5 rounded transition-colors active:scale-90 ${
                        isChatActive ? 'bg-emerald-900/40 ring-1 ring-emerald-500/30' : 'hover:bg-fleet-surface-2'
                      }`}
                    >
                      <MessageSquare
                        size={16}
                        className={isChatActive ? 'text-emerald-400' : 'text-emerald-400/40'}
                      />
                    </button>
                  </MiniSidebarTooltip>
                );
              })}
```

Add `MessageSquare` to the existing `lucide-react` import in `App.tsx`.

- [ ] **Step 4: Sidebar Tools section**

The expanded sidebar's Tools list renders from `TOGGLEABLE_TOOLS` (Task 1 already added the `chat` entry) and the tools picker toggles `FleetSettings.tools.chat`. Confirm the Chat row appears in the Tools picker. If `Sidebar.tsx` has per-tool hardcoded cards (like `SessionsTabCard`/`KanbanTabCard`) rather than a generic map, add a `chat` case mirroring the `sessions` card; otherwise no change is needed beyond Task 1.

- [ ] **Step 5: Typecheck, lint, build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run lint`
Expected: PASS.
Run: `npm run build`
Expected: PASS (full build including both typechecks).

- [ ] **Step 6: Manual smoke test**

Run: `npm run dev`
Verify, in order:
1. Settings → Tools: enable **Chat**. A Chat tab pins to the sidebar with a Chat icon.
2. Open Chat → the no-key banner shows. Go to the tool's **Settings** view, paste a real OpenRouter key, **Save** → status shows "Saved ✓".
3. Back in **Chat**: the model picker populates from `/models`. Pick a model.
4. Type a message, **Enter** → the assistant response **streams in** as markdown (code blocks render). The Stop button appears while streaming.
5. Create a second conversation, switch between them — histories are independent.
6. Quit and relaunch Fleet → conversations persist; the key is still saved.
7. Temporarily set a bad key → send → an inline error with the message appears; partial text (if any) is preserved.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/App.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(chat): wire Chat tool into tabs, sidebar, and tool visibility"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §1 Chat tool in Tools section → Tasks 1 (registry), 9 (wiring). ✅
- §2 Architecture (client/store/secrets/service/IPC/renderer) → Tasks 2–6. ✅
- §2.2 streaming events keyed by streamId → Task 5 service + Task 6 store. ✅
- §3 extensible capability-namespaced settings + key separate + merge-with-defaults → Task 1 (types/merge), Task 5 (settings IPC), Task 3 (key). ✅
- §4 SQLite schema (conversations/messages, cascade, index) → Task 4. ✅
- §5 UI (rail/markdown/composer/model override) + error handling (no-key banner, request/mid-stream errors, preserved partials) → Tasks 7, 8; partial-preservation in Task 5 service + Task 6 store. ✅
- §6 verified API contract (headers, SSE rules, [DONE], comments, mid-stream error, /models normalize) → Task 2 (and its tests). ✅
- §7 extension seams (capability namespace, provider class, no tools[] built) → Task 1 types + Task 2 class; nothing speculative built. ✅
- §8 testing → tests in Tasks 1–6. ✅

**Placeholder scan:** No TBD/TODO; every code step contains complete code. UI tasks honestly use typecheck/build/manual verification because the repo has no renderer component-test harness (only store/lib/hook tests), which Task 6 does use. ✅

**Type consistency:** `ChatService.send` returns `ChatSendResponse {streamId, userMessage}` — matches preload `send`, store `send` (`res.streamId`, `res.userMessage`), and the service test. Stream payload types (`ChatStreamChunk/Done/ErrorPayload`) are identical across chat-types, service emits, preload `onStream*`, and store handlers. `ChatStore` method names match between Tasks 4, 5, and the service test. ✅

**Known integration seams flagged for the implementer (not gaps):** exact `getMainWindow`/`settingsStore` identifiers in `index.ts` (Task 5 Step 7); whether `FleetSettingsPatch` needs an explicit `ai` branch (Task 5 Step 5); whether `Sidebar.tsx` uses a generic tool map vs. hardcoded cards (Task 9 Step 4); whether the repo removes tool tabs on toggle-off (Task 9 Step 1). Each is called out at its step with the rule to follow.
