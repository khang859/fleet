# Follow the fix through the user-visible boundary

Re-review of #564–#570 after the first eight findings were addressed. Six fixes are complete; two stop before the final boundary. No application fixes were made during this review.

## Sources must reach a renderer

#564 now emits, stores, and round-trips annotation citations correctly. However, `messageCitations` is called only in tests, and `AgentThread.Message` renders reasoning and message parts without rendering `message.citations`. `AgentCitationList` is used only inside a server-tool row with `call.citations`. An annotation-only response therefore still has no visible source links.

The remaining fix is to render the merged message citations in the answer, then verify an annotation-only message in the renderer. Store tests calling a helper do not establish that the UI uses the helper.

## A round trip is not the same as a new user turn

#569 now forwards the stop conditions and preserves raw Responses output for later rounds of the same `runRounds` call. But `response_output` exists only in that call's local wire array. Output items are not carried through the renderer event, `AgentMessage`, or session schema; the final-answer branch also returns before adding the raw carrier.

The next user turn reconstructs history through `toWireHistory`, which produces `reasoning_details` from stored server-tool records. `toResponsesInput` ignores those details. The model's reasoning state and advisor exchanges are therefore still absent from subsequent user turns and restored sessions.

A temporary reproduction parsed the committed Responses fixture, verified that direct same-turn replay preserves reasoning and tool-search items, then rebuilt a persisted message through the actual `toWireHistory` and `toResponsesInput` functions. Both item types disappeared. The test was removed after verification and saved at `/private/tmp/fleet-pr-rereview-history.test.ts`.

The remaining fix is to preserve ordered raw round output through the durable message/event/session model and restore it when constructing a later turn. Verify two user turns and a session reload, including an answer round with no local calls. [OpenRouter's advisor documentation](https://openrouter.ai/docs/guides/features/server-tools/advisor#cross-request-memory) explicitly requires prior advisor output items in Responses input.

## Verified fixes

- #565 and #567 use a string draft and commit bounded numbers on blur; Enter blurs and Escape abandons the draft.
- #568 and #570 preserve list newlines until blur and then normalize the saved array.
- #569 forwards nonempty stop conditions when server tools are present.
- #570 adds the final tool-result cache breakpoint while keeping the internal tool-result shape unchanged.

The 18 focused test files passed all 458 tests at stack head `a655a080`; the separate history reproduction also passed, confirming the remaining failure. Typecheck, lint, and build passed. #566's head and base are unchanged from its previous no-findings review and 69 passing tests.
