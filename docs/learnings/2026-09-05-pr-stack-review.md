# Reviewing the OpenRouter PR stack

Review scope: #564, #565, #567, #568, #569, #570, plus standalone #566. Findings were checked against each PR's own base; application fixes are left to the PR authors.

## Transport boundaries need round-trip tests

- #564 collects annotation citations in `StreamOutcome.citations`, but the service only sends and persists `serverToolCalls`. Annotation-only sources disappear before reaching the transcript. Carry citations through the event and session model independently of whether a server-tool record exists.
- #569 accepts `serverToolStops` but omits `stop_server_tools_when` from the Responses body. Forward the conditions so enabling deferred tools preserves the existing cost and step brakes.
- #569 discards captured reasoning items and converts history through a shape that drops server-tool exchanges. Keep original Responses output items, including encrypted reasoning and advisor identity, and replay them unchanged. The advisor documentation explicitly supports this; test two requests through Fleet's conversion rather than only parsing a captured second response.
- #570 only marks the final message when it is a user message. Tool rounds with no reminder end in tool results, so their growing transcript receives no cache breakpoint. Mark a supported final content block and test a real tool-call/result history without todos.

Sources: [Responses request](https://openrouter.ai/docs/api/api-reference/responses/create-a-response), [advisor replay](https://openrouter.ai/docs/guides/features/server-tools/advisor#cross-request-memory), [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching). Search returned an older Responses documentation slug that now gives 404; the current caching guide links to the replacement above.

## Preserve drafts in controlled settings fields

- #565 and #567 clamp numeric values on every keystroke. Replacing the advice budget with `4096` changes the first `4` to `256`; replacing the panel budget with `8000` changes the first `8` to `1000`. Keep a string draft and validate on blur or commit.
- #568 and #570 split, trim, and remove empty lines on every textarea change. Pressing Enter after the first domain/provider immediately removes the newline. Keep the textarea draft until commit and normalize only the saved list.

Six temporary reproduction tests verified these behaviors using the actual request builders, captured fixture, and settings component handlers. They were removed after verification; the reproduction file and logs were saved under `/private/tmp/fleet-pr-review-*`.

## Verification environment

The initial broad agent test selection reached unrelated tests that need loopback listeners and writes outside the sandbox, producing permission failures and timeouts. Stop that run rather than treat those failures as PR regressions. The bounded selection of 14 relevant test files passed all 318 tests; #566 was separately archived at its exact head into a temporary directory and all 69 workspace-store tests passed. Type checking and lint passed before the temporary reproductions were added; the full build also passed after their removal.

The sandboxed CLI authentication check misleadingly reported an invalid token. The GitHub connector could read metadata but returned `Resource not accessible by integration` when submitting a review. Retrying the CLI with approved network access succeeded without changing credentials. Use that authenticated CLI to submit the requested comments. Because its account owns these PRs, the no-findings result on #566 is a COMMENT review stating approval, not a formal APPROVED review.

A shell search also used an unmatched unquoted glob; use explicit paths or `rg` file filters to avoid zsh rejecting a search before it runs. Process inspection was unavailable in the sandbox, so the known test session was stopped through its existing execution handle instead.
