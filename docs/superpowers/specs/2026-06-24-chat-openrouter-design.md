# Chat (OpenRouter) — Design

**Date:** 2026-06-24
**Status:** Approved design, pending implementation plan
**Scope:** A general-purpose AI chat assistant inside Fleet, powered by OpenRouter. Ships as a focused **Chat** tool in the Tools section.

---

## 1. Goal & Scope

Add a general-purpose AI chat assistant to Fleet — a docked "ChatGPT inside Fleet" experience — backed by OpenRouter as the only provider in v1.

### In scope (v1)

- A new pinned **Chat** tab (`type: 'chat'`) in the Tools section, with an internal view switcher: **Chat** and **Settings** (mirrors the Images tab pattern).
- **Multiple conversations**, persisted to disk (SQLite), switchable from a left rail.
- **Streaming** assistant responses (SSE), rendered as markdown.
- **Live model picker** populated from OpenRouter's `/models` endpoint; a default model in settings plus a per-conversation override.
- **API key** entered in the Chat tool's own Settings view, stored encrypted via Electron `safeStorage`.

### Explicitly out of scope (v1) — future seams only

Image/video generation, a unified asset library, MCP/Skills, and search tools (Exa, etc.) are **not built** in v1. The design leaves clean seams so each is additive later (new config + new file, never a refactor). See §7.

---

## 2. Architecture & Data Flow

Three layers, following Fleet's existing IPC conventions.

### 2.1 Main process — `src/main/chat/`

- **`openrouter-client.ts`** — implements a small `ChatProvider` interface. Talks to OpenRouter's REST API using **native `fetch`** (Electron main is Node 18+; no new HTTP dependency).
  - `listModels()` → `GET https://openrouter.ai/api/v1/models`
  - `streamCompletion(opts, onChunk, signal)` → `POST https://openrouter.ai/api/v1/chat/completions` with `stream: true`, parsed as SSE.
- **`chat-store.ts`** — persists conversations + messages to **SQLite** via `better-sqlite3` (same dependency Kanban uses), at the app data path. Schema in §4.
- **`chat-secrets.ts`** — stores/retrieves the OpenRouter API key encrypted via `safeStorage` (same pattern as `env-sync/env-sync-secrets.ts`). The plaintext key never crosses IPC to the renderer.

### 2.2 IPC layer

New channels under a `chat:` domain, registered in `src/main/ipc-handlers.ts`, typed in `src/shared/ipc-api.ts`, constants in `src/shared/ipc-channels.ts`, exposed in `src/preload/index.ts`.

Request/response (invoke):

| Channel | Purpose |
|---|---|
| `chat:listConversations` | list conversation metadata (id, title, updatedAt) |
| `chat:createConversation` | create a new conversation, returns id |
| `chat:renameConversation` | rename |
| `chat:deleteConversation` | delete + its messages |
| `chat:getMessages` | messages for a conversation |
| `chat:send` | persist user msg, kick off streaming completion (see events) |
| `chat:cancel` | abort an in-flight stream (AbortController) |
| `chat:listModels` | proxy `/models`, returns normalized model list |
| `chat:getSettings` | return `ChatSettings` (merged with defaults) |
| `chat:patchSettings` | partial update of `ChatSettings` |
| `chat:setKey` | encrypt + store API key |
| `chat:hasKey` | boolean — is a key stored? (never returns the key) |

Streaming uses the fire-and-forget event pattern (main → renderer), keyed by a `streamId` returned from `chat:send`:

| Event | Payload |
|---|---|
| `chat:stream-chunk` | `{ streamId, delta }` — append text |
| `chat:stream-done` | `{ streamId, messageId }` — full assistant msg persisted |
| `chat:stream-error` | `{ streamId, message, partial }` — error; partial text preserved |

### 2.3 Renderer — `src/renderer/src/`

- **`store/chat-store.ts`** (Zustand) — mirrors the existing `pm-chat-store.ts`. Holds: conversation list, active conversation id, messages, in-flight streaming buffer, model list, loading/error state. Subscribes to the `chat:stream-*` events and appends chunks to the in-flight assistant message.
- **`components/chat/`** — `ChatTab.tsx` (shell + view switcher), `ChatView.tsx` (rail + scrollback + composer), `ChatSettingsView.tsx` (sections), `ConversationList.tsx`, `MessageList.tsx`, `Composer.tsx`, `ModelPicker.tsx`.

### 2.4 Send flow

```
User types → renderer chat-store.send(text)
  → window.fleet.chat.send({ conversationId, text, model })
  → main: persist user msg → returns { streamId }
  → main: POST /chat/completions (stream:true) with full message history
  → for each SSE data chunk: emit chat:stream-chunk { streamId, delta }
  → renderer: append delta to in-flight assistant bubble
  → on [DONE]: main persists assistant msg → emit chat:stream-done
  → on mid-stream error / HTTP error: emit chat:stream-error (partial saved)
```

The full prior message history of the conversation is sent on each request (standard stateless chat-completions contract).

---

## 3. Settings (built to grow)

Chat settings live as a structured object in `FleetSettings`, namespaced by **capability** so future capabilities slot in additively with no migration. The API key is stored separately (encrypted), referenced — never inlined — in settings.

```ts
// src/shared/types.ts
export type ChatSettings = {
  provider: 'openrouter';        // only value in v1; widens later
  defaultModel: string;          // e.g. 'anthropic/claude-3.5-sonnet'
  // future fields slot here with safe defaults (no breaking change):
  // temperature?: number;
  // systemPrompt?: string;
  // maxTokens?: number;
};

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  provider: 'openrouter',
  defaultModel: 'anthropic/claude-3.5-sonnet',
};

// Capability-namespaced container (future: image, video, etc.)
export type AiSettings = {
  chat: ChatSettings;
  // image?: ImageSettings;   // future — may absorb existing image-providers config
  // video?: VideoSettings;   // future
};
```

**Merge-with-defaults on read:** `chat:getSettings` always returns `{ ...DEFAULT_CHAT_SETTINGS, ...stored }`, so any field added in a future version gets its default automatically for existing users — no migration code.

**Generic settings IPC:** `chat:getSettings` / `chat:patchSettings(partial)` (partial-update, like Fleet's existing `settings:set`). Adding a setting never requires a new channel. The API key keeps its own `chat:setKey` / `chat:hasKey` channels since it is encrypted separately and never round-trips to the renderer in plaintext.

**Settings view UI** — section-based (not a flat form) so new groups drop in as new sections:

- **API Key** — password input; status shows `Saved ✓` / `Not set`; validate-on-save via a test `GET /models` call.
- **Default Model** — the live, searchable model picker.
- *(future sections — Behavior, System Prompt, Generation params — slot in here.)*

---

## 4. Persistence — SQLite schema

A dedicated SQLite DB (via `better-sqlite3`) at the app data path, e.g. `chat.db`. Chosen over localStorage/JSON because conversation histories grow unbounded; SQLite keeps loads fast and queries simple, and the dependency is already bundled for Kanban.

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'New chat',
  model       TEXT,                 -- per-conversation override; null → use default
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,    -- 'user' | 'assistant' | 'system'
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
```

Title defaults to "New chat"; v1 may set it from the first user message (truncated). Auto-title-from-LLM is a future setting, not v1.

---

## 5. Chat UI & Error Handling

### Layout (Chat view) — three regions, mirroring the Sessions tab shell

- **Left rail:** conversation list. "New chat" button; click to switch; right-click to rename/delete. Collapsible.
- **Main:** message scrollback with **markdown rendering** (reuse Fleet's existing markdown renderer — code blocks, lists, etc.). The streaming assistant message animates in as chunks arrive.
- **Bottom:** composer — textarea, **Enter** to send / **Shift+Enter** newline. A per-conversation model override dropdown sits next to Send (defaults to `defaultModel`). A Stop button replaces Send while streaming (`chat:cancel`).

### Styling

Tailwind + Fleet semantic tokens (`bg-fleet-surface`, `text-fleet-text`, `border-fleet-border`, `--fleet-accent`). Radix primitives for dropdown/menu (consistent with the rest of the app). `lucide-react` icons (e.g. `MessageSquare` for the tab).

### Error handling

- **No API key set** → Chat view shows an inline banner: "Add your OpenRouter API key in Settings" with a button that switches to the Settings view.
- **Request failure (401 / 429 / network)** → assistant bubble shows the error inline + a **Retry** button; any partial streamed text is preserved.
- **Mid-stream error (HTTP 200 with `error` + `finish_reason: "error"`)** → handled the same as a request failure; partial text preserved (see §6).
- **Stream interrupted** (cancel, app teardown) → whatever streamed so far is saved; no DB corruption.

---

## 6. Verified OpenRouter API contract

Verified against current OpenRouter docs (Context7 + live docs, 2026-06-24).

### Chat completions — `POST /api/v1/chat/completions` (OpenAI-compatible)

- **Headers:** `Authorization: Bearer <key>`, `Content-Type: application/json`, plus optional `HTTP-Referer` and `X-Title` for OpenRouter app attribution (we send these identifying Fleet).
- **Body:** `{ model, messages: [{ role, content }], stream: true }`.
- Use the **standard chat-completions** shape (`choices[0].delta.content`), **not** the newer "Responses" API — the chat-completions shape is universally supported across all models.

### SSE streaming — parsing rules

- Each line is `data: {json}`; extract `choices[0].delta.content`.
- Stream terminates on the literal `data: [DONE]` sentinel.
- OpenRouter sends keep-alive **comment** lines `: OPENROUTER PROCESSING` to prevent timeouts → **ignore** them (good signal for a "thinking…" indicator).
- **Mid-stream errors arrive with HTTP 200** as an SSE event with a top-level `error` and `finish_reason: "error"` → must check explicitly, not rely on HTTP status. Partial text before the error is preserved.
- Implementation: native `fetch` + `response.body.getReader()` + `TextDecoder`, buffering on `\n` (per OpenRouter's own TS example).

### Models — `GET /api/v1/models`

- Bearer token in header. Returns `data[]`; each model has `id`, `name`, `context_length`, `pricing.{prompt,completion}`, `architecture`, `description`.
- Picker shows name + context length; searchable by id/name. Client normalizes to `{ id, name, contextLength }` for the renderer.

**Sources:**
- https://openrouter.ai/docs/api/reference/overview
- https://openrouter.ai/docs/api/reference/streaming
- https://openrouter.ai/docs/api/api-reference/models/get-models

---

## 7. Extension Seams (leave room, build none)

v1 builds **only** text chat via OpenRouter. The following futures are documented so v1's data shapes and module boundaries don't have to be torn up later. **None are implemented in v1.**

| Future capability | Seam left in v1 | What v1 does |
|---|---|---|
| Image / video generation | Capability-keyed `AiSettings.{chat,image,video}`; `ChatProvider` interface has provider siblings (mirrors existing `ImageProvider`) | ships only `ai.chat` |
| Asset library ("get your assets") | Outputs route to Fleet's **existing** Images-gallery / a future generalized "Assets" tab — the Chat tool never owns asset storage | text-only, no assets |
| MCP / Skills | All three below reduce to **tool-calling**. Request shape permits a `tools[]` array; response handler tolerates `tool_calls`; message model is not hard-coded to text-only | sends no `tools` |
| Search tools (Exa, etc.) | Same `tools[]` seam — a search tool is one registered tool | sends no `tools` |

Per Fleet's CLAUDE.md (*Simplicity First — nothing speculative*): no tool-calling code, no provider registry, no asset plumbing is written now. The seams are: namespaced settings, a one-method-richer provider interface, and not hard-coding "messages can only be text."

---

## 8. Testing

- **OpenRouter client** — unit tests with a mocked SSE stream: correct delta extraction, `[DONE]` termination, `: OPENROUTER PROCESSING` comment skipping, mid-stream `error` handling, abort via signal.
- **Chat store (SQLite)** — CRUD round-trips: create/list/rename/delete conversations, append/list messages, cascade delete.
- **Settings merge** — `getSettings` returns defaults merged over stored partials; `patchSettings` updates only provided fields.
- **Secrets** — `setKey`/`hasKey` round-trip via `safeStorage` (mockable); plaintext key never returned to renderer.

Verification commands (from CLAUDE.md): `npm run typecheck`, `npm run lint`, `npm run build`.

---

## 9. Files Touched (summary)

**New (main):** `src/main/chat/openrouter-client.ts`, `chat-store.ts`, `chat-secrets.ts`, `chat-ipc.ts` (handler registration).
**New (renderer):** `src/renderer/src/store/chat-store.ts`, `src/renderer/src/components/chat/{ChatTab,ChatView,ChatSettingsView,ConversationList,MessageList,Composer,ModelPicker}.tsx`.
**Edited:** `src/shared/types.ts` (`ChatSettings`, `AiSettings`, `Tab.type` union += `'chat'`), `src/shared/ipc-channels.ts`, `src/shared/ipc-api.ts`, `src/preload/index.ts`, `src/main/ipc-handlers.ts` (wire `chat-ipc`), `src/renderer/src/store/workspace-store.ts` (`ensureChatTab`), Tools/sidebar registration where Images/Sessions tools are listed, tools-visibility settings.
