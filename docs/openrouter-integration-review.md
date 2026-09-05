# OpenRouter integration review

Reviewed September 5, 2026 against Fleet commit `23a32486` and OpenRouter's live documentation. This is a capability assessment and implementation proposal; no paid inference calls or application changes were made. Context7 tools were unavailable in this session, so the documentation was read directly from OpenRouter.

**Recommendation:** add model-directed web search first, then an optional Advisor, and build a Responses transport when ready to introduce deferred MCP tool discovery. Keep Fleet responsible for the local workspace, approvals, execution, and durable task state. OpenRouter can handle more of the remote research and model orchestration.

OpenRouter marks server tools as beta. They are supplied in the request's `tools` array and generally execute inside OpenRouter's model loop, alongside Fleet's ordinary function tools. The individual tool documentation matters: Apply Patch still requires client execution, and several tools are unavailable on Chat Completions. [Server tools overview](https://openrouter.ai/docs/guides/features/server-tools).

**Fleet already has a substantial foundation.**

- `src/main/agent/completions.ts` implements streaming Chat Completions, function calls, reasoning text, token/cache usage, total cost, and the serving model/provider.
- `src/main/agent/model-routing.ts` supports OpenRouter and local OpenAI-compatible endpoints. Server-tool configuration must be gated to OpenRouter requests.
- `src/main/agent/web/fetch.ts` already reads URLs locally, extracts Markdown, and supports browser rendering through its dependencies. This also serves local development URLs under Fleet's URL policy.
- `src/main/agent/images.ts` and `tools/image.ts` already provide OpenRouter image generation, partial previews, reference-image editing, local storage, and cost accounting. `transcribe.ts` uses OpenRouter for transcription.
- `src/main/agent/agent-service.ts` already runs local tools and subagents through Fleet's permission gate, loads project instructions, and injects current time.
- `src/main/agent/mcp/manager.ts:getToolSpecs()` supplies all enabled tools from connected MCP servers. Their definitions are included in subsequent model requests; there is no deferred discovery in this path.

**Ranked opportunities**

| Priority | Integration                                 | Fleet use case                                                                         | Compatibility and tradeoff                                                                                                                     |
| -------- | ------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Web Search                                  | Find library docs, issues, releases, and current answers without first knowing a URL   | Works on Chat Completions. Adds a capability absent from Fleet's built-in tool list. Needs source rendering and usage support.                 |
| 2        | Advisor                                     | Let a fast coding model consult a stronger model on design decisions or difficult bugs | Works on Chat Completions. Pin the advisor model and output budget; pass a focused question and relevant code.                                 |
| 3        | Tool Search                                 | Discover relevant MCP tools as integrations grow                                       | Requires Responses or Messages; Chat Completions returns 400. Keep frequently used local tools loaded and defer less common integration tools. |
| 4        | Fusion                                      | Explicit multi-model design critique or review of a supplied diff                      | Works on Chat Completions, but docs recommend Responses for lower latency. Multiple panel calls plus an analyst increase spend.                |
| 5        | Hosted Subagent                             | Delegate document summaries, extraction, and public-web research to a cheaper worker   | Basic use fits Chat Completions. Local function inheritance requires Responses and is experimental.                                            |
| 6        | Hosted Web Fetch                            | Read public PDFs or offer an alternative extraction engine for public pages            | Add selectively; Fleet already has local fetch and rendering. Hosted fetch does not inherit Fleet's local network or browser session.          |
| Later    | Hosted Shell / Apply Patch                  | Isolated computation and artifact generation; validated patch proposals                | Requires a new API transport and separate execution/artifact handling. These are not replacements for the local terminal workflow.             |
| Low      | Image Generation / Datetime / Search Models | Optional simplification or conversational model discovery                              | Images and current time already have Fleet implementations. Model search is experimental and does not replace the existing model catalog.      |

**1. Web search is the best first slice.**

Use `openrouter:web_search`, with a simple Agent setting and a bounded number of searches. The model can search zero or more times as needed. The old `plugins: [{ id: "web" }]` and `:online` paths are deprecated, so new work should use the server tool. Search supports native providers plus Exa, Parallel, Perplexity, and Firecrawl. [Web Search](https://openrouter.ai/docs/guides/features/server-tools/web-search).

Start with one deliberate engine choice. `auto` maximizes native integration, but filters and limits differ by provider; a fixed engine such as Exa gives a more predictable first implementation. The documented Exa fast/auto price is $0.007 per request for up to ten results; Parallel fast/turbo is $0.001, with model-token charges additional. These are current documentation prices, not a performance recommendation. Evaluate relevance and latency on Fleet tasks before selecting a cheaper default. [Search configuration and pricing](https://openrouter.ai/docs/guides/features/server-tools/web-search).

Preserve citations in the transcript and expose source links. Continue to use Fleet's local `web_fetch` when inspecting localhost or a page it can already read. Hosted fetch is an optional public-web alternative: OpenRouter's direct HTTP engine has no additional fetch charge; Exa and Parallel are documented at $0.001 per fetch, plus model tokens. Avoid automatically offering two indistinguishable fetch tools. [Web Fetch](https://openrouter.ai/docs/guides/features/server-tools/web-fetch).

**2. Advisor and Fusion address different needs.**

Advisor is a focused consultation during the coding loop. A useful initial configuration is one pinned stronger model, `forward_transcript: false`, and bounded output. Fleet supplies the relevant diff/code through the executor's question. Full transcript forwarding is available but makes consultations larger. Named advisors are possible later. Incremental advice streaming is Responses-only; the Chat Completions result arrives after the consultation finishes. Advisor identity is positional, so tool-entry ordering must stay stable when replaying memory. [Advisor](https://openrouter.ai/docs/guides/features/server-tools/advisor).

Fusion is better exposed as an explicit review action. It runs 1–8 panel models plus an analyst and can return consensus, disagreements, unique findings, and blind spots. Panel and analyst calls have web search/fetch, but no documented access to Fleet's local repository tools. Supply the diff, relevant files, and project constraints; the panel cannot independently inspect this checkout. Handle partial panel failure and successful responses lacking analyst output. [Fusion](https://openrouter.ai/docs/guides/features/server-tools/fusion).

Hosted subagents are suitable for self-contained inputs and web research. Fleet's existing local subagents remain valuable because they can inspect and operate on the workspace. Responses-only function inheritance can bridge hosted workers to Fleet later, but requires preserving opaque `subagent_items`, attribution, and suspend/resume history. It does not remove Fleet's execution or permission responsibilities. [Subagent](https://openrouter.ai/docs/guides/features/server-tools/subagent).

**3. Tool discovery is the strongest reason to add Responses support.**

OpenRouter's regex-based Tool Search reveals deferred definitions on demand across models/providers. Keep common tools such as read/edit/bash available and defer less frequently used MCP tools. Discovery changes availability, not execution: Fleet still dispatches the discovered function through its MCP manager and permission gate. The docs explicitly reject this tool on Chat Completions. Measure current tool-definition tokens and selection failures first; then add a Responses adapter alongside the existing local-compatible transport. [Tool Search](https://openrouter.ai/docs/guides/features/server-tools/tool-search).

Hosted Shell offers a separate isolated Linux environment, with no outbound network by default. It needs container lifecycle and file transfer integration for useful Fleet artifacts. Apply Patch validates V4A patches but leaves application of changes to Fleet. Treat these as later capabilities with their own product scope. [Shell](https://openrouter.ai/docs/guides/features/server-tools/shell), [Apply Patch](https://openrouter.ai/docs/guides/features/server-tools/apply-patch).

**The shared implementation work is larger than adding tool names.**

`ToolSpec` in `src/shared/agent-tools.ts` currently accepts only function definitions. Add a distinct server-tool wire type and combine it at the OpenRouter request boundary, keeping local dispatch restricted to executable client functions. Include remote tools only in appropriate interactive/research calls, not automatically in title generation, compaction, or permission classification.

The streaming parser currently accepts text, reasoning text, function calls, and a limited usage object. It drops `reasoning_details` and citation annotations. The Chat API reference defines `reasoning.server_tool_call` records with tool name, arguments, result, and call ID specifically for replay. Preserve relevant provider records through streaming, session persistence, and history reconstruction; display completed remote work without trying to execute it again locally. Capture actual streaming fixtures before committing to progress-event semantics. [Chat API reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion).

There is documentation drift to account for: the feature guide shows `usage.server_tool_use`, while the Chat API reference specifies `usage.server_tool_use_details`. Its search counts overlap with general server-call counts and must not be summed. The reference also exposes `cost_details.server_tool_cost` for metered execution. Keep reported total cost authoritative and treat details as a breakdown, verifying actual payloads to avoid double counting. [Chat usage schema](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion).

The outer server loop defaults to 30 steps. `stop_server_tools_when` replaces `max_tool_calls`, so configure both step and spend stop conditions inside that array when using it. A cost stop is a threshold, not an exact billing ceiling: the documented behavior executes pending calls and performs a final answer turn. Fleet also needs a budget across its own repeated requests, since per-request limits restart on each round; Fusion/worker loops have separate inner budgets. [Loop limits](https://openrouter.ai/docs/guides/features/server-tools), [Stop-condition contract](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion).

**Adjacent OpenRouter improvements worth measuring:** explicit prompt caching for supported models/providers, routing preferences for latency or price, and user-selected fallback models. Fleet already reports cache usage and the serving model/provider, but the completion request builder does not expose these controls. Some providers cache automatically, so measure incremental savings instead of claiming all current requests miss the cache. A provider's `max_price` constrains rates, not total turn spend. [Prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks).

**Suggested delivery sequence and acceptance criteria**

1. **Search and supporting protocol changes:** verify mixed local/server calls, citation persistence after reopening a session, remote-tool history replay, cost accounting, cancellation, disabled-tool behavior, and unchanged local-endpoint requests. Compare live fixtures across at least two model families.
2. **Advisor, then explicit Fusion review:** verify focused context delivery, bounded calls, degraded results, replay ordering, and intelligible review output. Benchmark task quality, latency, and total cost against Fleet's current local subagent approach.
3. **Responses transport and deferred MCP discovery:** verify streamed item reconstruction, history replay, tool discovery followed by permission-gated execution, reconnects, cancellation, and measured tool-token savings.

Run the relevant protocol/service tests plus `npm run typecheck`, `npm run lint`, and `npm run build` for implementation changes. This review itself changes documentation only; application tests were not run.
