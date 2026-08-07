# Duplicate `${VAR}` Expanders Drifted Between Chat and Agent MCP

Chat and Agent each shipped their own copy of the MCP config variable expander (`src/main/chat/mcp/expand.ts` and `src/main/agent/mcp/expand.ts`).
Chat's came first (#292/#316); Agent's was written later (#486) as a deliberate improvement, and the lesson never propagated back.

The two disagreed on both of the cases that matter:

| input | agent copy | chat copy |
| --- | --- | --- |
| `Bearer ${GITHUB_TOKEN}` (unset) | `Bearer ${GITHUB_TOKEN}` | `Bearer ` |
| `${PORT:-8080}` | `8080` | `${PORT:-8080}` (literal) |

Chat blanked an unset variable, turning "you never set `GITHUB_TOKEN`" into a 401 whose message says nothing about the cause.
Chat's regex also required `}` immediately after the name, so `${VAR:-default}` never matched and was passed through verbatim into a URL or an argv entry.
This broke the promise stated at the top of `shared/mcp-types.ts` - that the standard `mcpServers` blob can be pasted from a README and just work.

Nothing caught it because each copy had its own test file asserting its own behaviour.
Chat's test actively locked the bug in with `it('expands unknown variables to empty string')`, and had no `${VAR:-default}` case at all.
Two green test files can still describe two contradictory behaviours.

## Fix

Both copies were replaced by one module at `src/main/mcp-expand.ts` (the Agent implementation, which is the correct one).
It lives at the `main/` root rather than under `chat/` or `agent/` because those two trees deliberately share zero imports - Agent is a from-scratch build, not an extension of the Chat harness - and a config pasted into either has to expand identically.

## Takeaways

- Two copies of a pure function in sibling feature trees will drift, and per-copy unit tests hide the drift instead of exposing it. The signal to watch for is the same filename appearing twice.
- Regression tests for this class of bug belong at the level the user hits it. The new cases live in `chat/mcp/__tests__/manager.test.ts` and assert the URL the transport actually receives, so a re-introduced local copy fails there and not only in a util test.
- Verify a regression test has teeth by reverting the fix and watching it fail. Both new cases were confirmed to fail against the old implementation before being kept.
- An unset variable should stay visible in the output rather than collapse to empty. The downstream server's own error then names the variable; a blanked one produces a failure that explains nothing.
