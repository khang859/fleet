# Plan: Per-session chat workspace under `~/.fleet/chat`

**Date:** 2026-06-27
**Problem:** The chat tool's default workspace is `process.cwd()` (via `defaultWorkspace()` in
`fs-tools.ts:315`), which is unpredictable (`/` when launched from Finder) and unsafe. It drives the
fs/bash tool cwd + writable root, the `@`-mention search root, and `@`-mention context injection.

## Decisions (confirmed with user)

1. **Full sandbox** per conversation when no explicit `workspaceDir` is set: the per-session folder is
   the cwd + writable root + read root + `@`-mention root.
2. **Explicit `workspaceDir` still overrides** the per-session default (only the fallback changes).
3. **Images move** into the session folder (sibling of the agent root).
4. **Confine reads** to the workspace (positive allowlist mirroring writes) + `realpathSync` symlink
   hardening. *(Security: relocating cwd into `~/.fleet` otherwise puts the plaintext fal-ai key,
   kanban DB, other conversations, and PATH-wired binaries one `../` away from ungated reads.)*
5. **Fix the pre-existing fork bug** (forked conversations share parent image files by ref → deleting
   the parent dangles them). Copy files + rewrite refs on fork.
6. **Delete both locations** on conversation delete (new `~/.fleet/chat/{id}` + legacy
   `userData/chat-images/{id}`). No migration of existing data otherwise.
7. Lifecycle: delete folder on conversation delete; add **Reveal in Finder**.

## Layout

```
~/.fleet/chat/{conversationId}/
  workspace/   ← agent cwd + writable + read + @-mention root (default; explicit workspaceDir overrides)
  images/      ← generated images + attachments (ALWAYS here, regardless of override)
```

## Changes

### New: `src/main/chat/chat-workspace.ts`
`ChatWorkspace` class over base `~/.fleet/chat` (+ legacy `userData/chat-images` for cleanup):
- `resolve(configured, conversationId)` → override (with `~` expansion, relative anchored to homedir
  not cwd) else `~/.fleet/chat/{id}/workspace/`, mkdir lazily.
- `imagesDir(id)`, `sessionDir(id)` (mkdir, for Reveal), `delete(id)` (rm new + legacy).
- All methods validate `id` matches the UUID shape before building a path (rmSync foot-gun guard).

### `src/main/chat/tools/fs-safety.ts` — confine reads + realpath
- `assertReadablePath(target, cwd, readableRoots)`: realpath the nearest existing ancestor, then
  enforce credential denylist **and** containment within `readableRoots`.
- `assertWritablePath` already confines; route it through the realpath'd check too.
- Helper `realpathExisting(abs)` to handle not-yet-created files.

### `src/main/chat/tools/tool-runner.ts`
- Move cwd resolution **inside** the `try` in `run()` (mkdir can throw → must surface as a tool error,
  not crash the turn). Resolve once: `cwd = workspace.resolve(cfg.workspaceDir, ctx.conversationId)`.
- Pass `readableRoots: [cwd]` to read tools; `writableRoots: [cwd]` (+ `tmpdir()` for bash as today).
- Inject `ChatWorkspace` into `ChatToolExecutor`.

### `src/main/chat/chat-service.ts`
- `buildContextBlock(paths, conversationId)` uses `workspace.resolve(tools.workspaceDir, conversationId)`.

### `src/main/chat/chat-ipc.ts`
- `CHAT_MENTION_SEARCH(query, conversationId)` → resolve root via workspace; guard missing id → `[]`.
- New `CHAT_REVEAL_FOLDER(conversationId)` → `shell.openPath(workspace.sessionDir(id))`.
- Fork handler copies images (see below). Delete handler routes through `workspace.delete(id)`.

### `src/main/chat/image/image-storage.ts`
- Take `ChatWorkspace`; `save(id,...)` writes to `workspace.imagesDir(id)`.
- Add `copyInto(srcRef, conversationId)`: copy file → `imagesDir(id)/{uuid}.ext`, return new ref.
- Remove its own `deleteConversation` (deletion owned by `ChatWorkspace.delete`).

### `src/main/chat/chat-store.ts` — fork fix
- `forkConversation(messageId, mapImageRef?)`: after the new conversation id exists, run each copied
  image ref through `mapImageRef(ref, newConvId)`. IPC passes
  `(ref, cid) => imageStorage.copyInto(ref, cid)`.

### `src/main/index.ts`
- Construct `new ChatWorkspace(join(homedir(),'.fleet','chat'), join(app.getPath('userData'),'chat-images'))`.
- Inject into executor, IPC, service, image storage.

### `src/shared/ipc-channels.ts` / `src/preload/index.ts`
- Add `CHAT_REVEAL_FOLDER`; `mentionSearch(query, conversationId)`, `revealFolder(id)`.

### `src/renderer/src/components/chat/Composer.tsx`
- Pass `useChatStore` `activeId` to `mentionSearch` (skip when null).

### Conversation actions UI
- Add "Reveal in Finder" → `window.fleet.chat.revealFolder(id)`.

### `src/renderer/src/components/chat/settings/AgentToolsSection.tsx`
- Update copy: placeholder/description note the isolated per-chat default + absolute-path expectation.

## Tests (TDD for the risk-bearing pieces)

- `chat-workspace`: resolve override (`~` expansion, relative→home, absolute passthrough); default →
  `workspace/`; `delete` removes both locations + id-shape guard rejects `..`/`''`.
- `fs-safety`: read denied outside workspace; read of `../images/settings.json` from
  `~/.fleet/chat/{id}/workspace` denied; symlink-to-outside (read + write) denied via realpath;
  in-workspace read/write allowed; credential denylist still enforced.
- `image-storage`: `copyInto` produces an independent file under the new conversation.
- fork regression: fork → delete parent → fork images still load; a follow-up image-context turn
  doesn't throw.

## Known limitations (documented, out of scope)
- bash reads aren't confined off-Linux (no sandbox on macOS/Windows); governed by mode + approval as
  today. The native read tools (`read_file`/`glob`/`search`) *are* confined by this change.
- `fleet-image://` protocol remains an allowlist-free file server (renderer-trust boundary).
- Abandoned (never-deleted) conversations leave folders; no GC sweep added.
