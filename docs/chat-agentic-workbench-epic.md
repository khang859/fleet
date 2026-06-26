# Epic: Chat as an Agentic Workbench

Turn the Chat tool from a single-tool chat UI into a configurable agentic workbench: local file/shell access, MCP servers, Agent Skills, and self-naming sessions — all surfaced and editable in Chat settings.

## Architecture decision

**Chat stays OpenRouter-native.** All capabilities below are built natively into the existing OpenRouter tool-calling loop (`src/main/chat/chat-service.ts`, the loop at ~L96–241, `MAX_TOOL_ROUNDS`). We do **not** pivot to a headless agent. Consequences:

- We build an MCP **client** (Fleet today only has MCP *servers*), a native skill loader, and native bash/fs tools.
- We own the permission + sandbox engine.
- We keep multi-model selection, the image-gen tool, and full control of the in-chat tool-call/approval UX.

## Current state (baseline)

- **Engine:** OpenRouter `/chat/completions`, streaming SSE, tool loop max 4 rounds. One tool today: `generate_image` (`src/main/chat/chat-tools.ts`).
- **Storage:** SQLite `chat.db` — `conversations` / `messages` / `message_images` (`src/main/chat/chat-store.ts`).
- **Settings:** `ChatSettings = { provider, defaultModel, imageModel }` stored under `ai.chat`; UI in `ChatSettingsView.tsx`.
- **No auto-naming** — conversations default to `'New chat'`; `renameConversation()` exists.
- **MCP precedent:** `learnings-mcp-server.ts`, `kanban-mcp-server.ts` (loopback JSON-RPC) — we know the protocol, but as a server.

## Key extension points

| Need | Location |
|---|---|
| New tool schema + handler | `chat-tools.ts` + tool loop in `chat-service.ts` (~L130–192) |
| New settings field | `ChatSettings` type (`src/shared/chat-types.ts`) + `ChatSettingsView.tsx` + `patchSettings()` |
| Background namer | new `src/main/chat/chat-namer.ts`, call after first exchange → `renameConversation()` |
| MCP client | new `src/main/chat/mcp/` client; inject tools into `streamCompletion` `tools` array |
| Skills | new `src/main/chat/skills/` loader; inject name+desc into system prompt |
| IPC | `CHAT_*` channels in `src/shared/ipc-channels.ts`; preload bridge `window.fleet.chat.*` |

---

## Phase 0 — Foundations (shared infra)

These are prerequisites reused by later phases. Build first.

1. **Task-model code path** — a separate cheap-model call (Haiku-class) decoupled from the chat model. Reused by auto-naming, later auto-tagging, web-search query gen.
2. **Permission engine** — `allow` / `ask` / `deny` rule arrays, evaluated **deny → ask → allow**, first match wins, deny beats allow at any scope. Persists generated prefix rules on "always allow". Lives in main process; renderer only renders cards + sends decisions. This engine gates bash (Phase 2) and MCP tools (Phase 3).
3. **In-chat tool-call card component** — collapsible card in the message stream: tool name, exact args/command, cwd, streamed stdout/stderr, and inline approval buttons (Allow once / Allow & remember `<prefix>` / Deny). Shared by every gated tool. **This is the highest-value UX surface in the epic — get it right once.**

**Verify:** unit tests on the rule evaluator (deny precedence, prefix match with word boundary, operator-aware splitting); card renders + round-trips a decision over IPC.

---

## Phase 1 — Background auto-naming (quick win, low risk)

**What:** new conversations show "New chat", then get a real title after the first assistant response completes.

**How:**
- New `src/main/chat/chat-namer.ts`. After the first user+assistant exchange persists, fire-and-forget the task model.
- Prompt: concise ≤5-word title, no punctuation/quotes/markdown, from `User: {first}` + `Assistant: {firstResponse}`.
- **Fallback cascade:** LLM title → first-line keyword extraction → `"Chat — {date}"`.
- Calls existing `renameConversation()`; emit an IPC update so the sidebar refreshes.
- **User rename locks the title** — add a `title_locked` flag (or treat any manual rename as locked); never auto-overwrite.

**Settings exposed:**
- Auto-name new chats — on/off.
- Naming model — dropdown (cheap default, separable from chat model).
- Timing — "After first response" (default) vs "Immediately from first message".

**Verify:** new chat gets a sensible title within ~2s of first response; manual rename survives a follow-up message; task-model failure falls back gracefully and never blocks the stream.

---

## Phase 2 — Bash / filesystem tools

**What:** the agent can read and search local files; optionally run shell commands under a permission gate.

**Tool decomposition (do NOT ship one shell tool):**
- `read_file(path, offset?, limit?)` — read-only, **never prompts**, enforces path deny-rules in main process.
- `glob(pattern, path?)` — file-name search, read-only, no prompt.
- `search(regex, path?, glob?)` — content search (ship ripgrep), read-only, no prompt.
- `bash(command, cwd?)` — **only gated tool.** Parse operator-aware (`&&`, `||`, `;`, `|`, `&`, newlines, backticks, `$()`); every subcommand must independently match the allowlist; strip wrappers (`timeout`/`nice`/`nohup`/`xargs`).
- *(Deferred)* `edit_file` / `write_file` — gated, separate from read.

**Default posture:** **read-only "Plan mode."** Read/glob/search always available; `bash` and writes **off by default**, opt-in per project. Eliminates the destructive-command class for the common Q&A case.

**Security (Electron specifics):**
- All fs/shell execution in **main process**; renderer never touches fs. Never trust tool args arriving over IPC — main process is the enforcement point.
- **Allowlist only — never a denylist** (Cursor's denylist had ≥4 documented bypasses).
- **Never let the model self-certify safety** (Cline's `requires_approval` flag was injectable). The gate is deterministic main-process code.
- Defense-in-depth sandbox: adopt `@anthropic-ai/sandbox-runtime` (Seatbelt macOS / bubblewrap+seccomp Linux) for `bash`; default writable = workspace + temp; default network = deny. "Auto-allow if provably sandboxed" → skip prompt.
- Pre-seed credential denies: `~/.ssh`, `~/.aws`, `.env`, `.npmrc`; scrub secret env vars before spawn.
- Hard circuit-breakers that prompt even in bypass: `rm -rf /`, `rm -rf ~`, writes to `.git/config` and to Fleet's own settings files.

**Settings exposed (new "Tools / Permissions" section):**
- Mode selector: **Read-only (default)** · Ask before run · Auto (sandboxed). Per-project override + global default.
- Permitted commands: editable allow/ask/deny list (`Bash(npm run *)` syntax) + one-click "promote past approval to permanent rule".
- Permitted paths: workspace + additional read dirs; explicit deny list pre-seeded with creds.
- Network: default-deny toggle + domain allowlist (for a future fetch tool).
- Sandbox: on/off + "fail closed if unavailable" + writable paths + credential scrub list.

**Verify:** read/glob/search work with no prompt and respect deny paths; `echo a && rm -rf x` does NOT match an `echo *` allow; "always allow" persists a rule scoped to project+prefix; sandbox blocks a write outside workspace.

---

## Phase 3 — MCP support (native client)

**What:** users add MCP servers; their tools become available to chat with per-call approval.

**How:**
- New MCP **client** in `src/main/chat/mcp/`: spawn/connect servers, `initialize` + `tools/list`, convert MCP tool schemas → OpenRouter function tools, inject into `streamCompletion`'s `tools` array, route matching `tool_calls` → `tools/call` → feed result back into the loop.
- **Adopt the standard `mcpServers` JSON schema verbatim** (users paste from READMEs). Transports: **Streamable HTTP** default for remote, **stdio** for local, SSE marked legacy.
- **OAuth 2.1 + PKCE** for remote servers; tokens in OS keychain; `state` param mandatory (CSRF).
- **Trust-on-first-use** for any project-committed server config (attack vector); store the decision, allow reset.
- Reuse the Phase 0 permission engine + tool-call card for approvals. Env-var expansion (`${VAR}`) so configs commit without secrets.
- Budget MCP output (warn >10k tokens, cap ~25k, spill to disk reference) to avoid context floods.

**Settings exposed ("MCP Servers" section):**
- Server list: status dot (connected/connecting/failed/pending-approval), tool count, enable/disable toggle, edit/delete, auth/clear-auth (remote), view-logs/restart (stdio).
- Add server: a form (name, transport dropdown → conditional command/args/env or url/headers rows) **plus** a "Paste JSON" tab accepting the standard blob.
- Scope selector on add (this project / all projects / shared-committed).
- Per-server expandable tool list with per-tool checkboxes + an auto-approve column for safe read-only tools.
- Import from Claude Desktop / Cursor.

**Verify:** add a stdio server (e.g. filesystem) → its tools list in chat → a tool call shows the approval card → result feeds back; disable toggle hides tools without deleting config; remote OAuth round-trips and token persists.

---

## Phase 4 — Skills support

**What:** folder-based Agent Skills (`SKILL.md`) that teach the agent workflows, loaded on demand.

**How (progressive disclosure):**
- New `src/main/chat/skills/` loader. At startup inject only `name`+`description` (~100 tokens each) into the system prompt.
- On trigger, load the SKILL.md body — via a `load_skill(name)` tool or the Phase 2 `read_file`. Bundled scripts run via `bash`; only their output enters context.
- **Adopt the Agent Skills open standard verbatim** (`SKILL.md` + `name`/`description` frontmatter, folder-based) — cross-tool, reusable. Fleet's learnings KB is a natural skill *producer*.
- **Dual invocation:** auto-trigger on description match **and** explicit `/skill-name`, with a `/` autocomplete menu in the composer.
- **Trust-gate** skills from untrusted sources before scripts / `allowed-tools` activate.
- **Context budget:** cap the description listing (~1% of window); evict least-used descriptions on overflow.

**Settings exposed ("Skills" section, sibling to MCP):**
- Skill list grouped by scope (Personal / Project / Bundled), each with a 4-state cycle: On / Name-only / Off (write to a settings overlay, never mutate the SKILL.md).
- Install: new-skill scaffold (SKILL.md template) + drag-drop/upload a zip + install-from-folder.
- Per-skill detail/audit view: rendered SKILL.md, frontmatter, bundled files, invocation flags as toggles. Prominent **audit affordance** for non-local skills (show scripts, flag network calls).
- **Context-budget meter** ("descriptions: 4.2k / 8k tokens") — a differentiator nobody else surfaces.

> Frame MCP + Skills as two tabs of one **"Extensions / Capabilities"** area: *MCP adds tools (connectivity), Skills add know-how (procedures), and they compose.*

**Verify:** drop a skill folder → it appears in settings + `/` menu; auto-triggers on a matching request; "Off" removes it from both; a bundled script runs via bash with only output in context.

---

## Backlog — researched high-impact additions (not in original ask)

Prioritized; fold in after the core four. These are where a developer-focused tool beats ChatGPT/Claude.ai (whose gaps — no real branching, title-only search, no folders — are well documented).

**High:**
- Message **edit + regenerate** with a `1 of N` version pager (baseline users expect).
- **Conversation branching/forking** — aligns with Fleet's worktree mental model.
- **@-mention file/folder context** — Cursor's signature feature; pairs with Phase 2 fs tools.
- **Token/cost display + prompt caching** — cache system prompt + tool defs (up to ~90% savings); surface `cache_read`/`cache_creation` token counts.
- **Slash commands / prompt templates** with fill-in variables.

**Medium:** full-text search across message *bodies* + folders/pinning; persona/system-prompt presets; image/PDF uploads; web-search tool (reuses Phase 0 task model for query gen); per-conversation Markdown export.

**Low / defer:** artifacts/canvas, voice input, auto-tagging (reuses Phase 0 task model).

---

## Recommended sequencing

```
Phase 0  Foundations (task model · permission engine · tool-call card)  → unblocks all
Phase 1  Auto-naming        → quick win, exercises task-model path
Phase 2  Bash/fs tools      → read-only default; exercises permission engine + card
Phase 3  MCP client         → reuses engine + card
Phase 4  Skills             → reuses fs/bash tools + system-prompt injection
Backlog  edit/regenerate → branching → @-mention → cost/caching → slash commands
```

Each phase ships independently and is dark-launchable behind a setting.

## Cross-cutting principles

- Allowlist only; never a denylist as the security boundary.
- Parse the shell — every subcommand/substitution matches independently; nothing smuggled via `$()` / backticks / `&&`.
- Deterministic main-process gate — never let the model (or model-authored config) self-certify safety.
- Standard schemas verbatim (`mcpServers`, `SKILL.md`) — users paste from the ecosystem and expect it to work.
- Read-only by default; opt in to power.
