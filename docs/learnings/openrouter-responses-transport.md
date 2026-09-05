# The OpenRouter Responses API, learned by capturing it

## What happened

Building `openrouter:tool_search` needed a second transport, because the tool is a 400 on Chat Completions.
The public documentation covers the request body and names the streaming events, but it does not say what an output item for a server tool looks like, and it does not say how a round with a discovered tool actually unfolds.
Writing the parser from the documentation alone would have meant guessing at the shapes that matter most.

## What was done instead

A temporary probe was added to `src/main/index.ts` behind an environment variable, which used the stored OpenRouter key to make two real `/responses` calls and wrote the raw SSE to a file.
One call armed a deferred tool and asked for it; the other replayed a `function_call` and its `function_call_output` as history.
Both streams were then trimmed - only the encrypted reasoning blobs were shortened - and committed as fixtures under `src/main/agent/__tests__/fixtures/`.
The probe was removed before the commit.

Everything the parser needed came out of those two files:

- A server tool arrives as an ordinary output item whose `type` is the tool's own name, e.g. `{"type":"openrouter:tool_search","status":"completed","query":"widget"}`. There is no `result` field on it.
- Reasoning items carry `encrypted_content` and a `format`. They are opaque and must be replayed unchanged.
- `response.completed` and `response.incomplete` both carry the entire finished `output` array. Reassembling items from the deltas is unnecessary work that can only disagree with what the server already sent.
- `usage` is the same accounting under different names: `input_tokens`, `output_tokens`, and the cached and reasoning counts one level deeper. `cost` and `server_tool_use_details` are spelled the same as on Chat Completions.
- The response object carries no `provider` field, so `StreamOutcome.provider` is always null on this transport.

## The rule

When an API's documentation is thin on exactly the shapes a parser depends on, capture a real stream before writing the parser.
A hand-written fixture only ever proves the parser agrees with whoever wrote the fixture.
A temporary probe inside the app is the cheapest way to make a real call with a key that is encrypted at rest, and it costs a few cents of tokens.

## A bug the tests caught

The first wiring armed the search tool on `settings.toolSearch.enabled && target.serverTools`.
That is true with the setting on and no MCP server connected, so the request carried a search tool with nothing to find - a tool that could only ever answer "nothing found", after the model had spent a round asking.
The condition is now `deferred.length > 0`: what is actually held back, rather than what the setting says.
