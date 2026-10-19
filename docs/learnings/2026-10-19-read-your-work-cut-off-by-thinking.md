# Read your work failed: the model's thinking used up its token limit

## What happened

"Read what I ticked" failed with "The Admiral's model sent back something Fleet could not read."
The read is one non-streamed call with `max_tokens: 3000` and `reasoning: { effort: 'low' }`.
On a reasoning model, thinking tokens count toward `max_tokens`.
A test read of 100 public commits on `deepseek/deepseek-v4.1-flash` used 2,250 reasoning tokens out of 2,305 completion tokens, so the answer had only about 700 tokens.
With CLAUDE.md, reviews and PR descriptions ticked too, the model thinks longer and writes more lines.
The answer then stops mid-JSON (`finish_reason: "length"`), or is empty, and the parser returns null.
OpenRouter's docs describe this case: "A small `max_tokens` can be consumed entirely by reasoning, returning `finish_reason: "length"` with empty `content`."

## Fix

- `READ_MAX_TOKENS` is 16,000. Only what is used is paid.
- `completeOnce` returns `finishReason`, and the read says "ran out of room" when the answer was cut off.
- `parseExtraction` drops `<think>` blocks and prefers the object that starts with `"lines"`, so braces in thinking or words do not break it.
- A failed parse logs `cutOff` and the answer's length, never its text, since it quotes the client's own work.

Strict `response_format: json_schema` was not used: OpenRouter fails the request on a model that does not support it, and the Admiral's model is the client's pick.

## Lesson

Size `max_tokens` for thinking plus the answer on any call to a model that may reason, and check `finish_reason` before blaming the format.
To reproduce a Read your work bug without the client's data, clone a public repository to the scratchpad and set its local `user.email` to one of its authors.
