# A reasoning model's default silently ate every short completion

## What happened

Auto mode was on, and commands that are plainly read-only still stopped and asked - `git log --oneline --decorate -8 main..<branch>` among them.
The feature appeared to be doing nothing at all, without an error anywhere.

## Why

`classifyCommand` asks a model for a single word and gives it eight tokens to say it in:

```ts
const MAX_TOKENS = 8;
```

`completeOnce` posted no `reasoning` parameter, so the model's own default applied.
On a reasoning model the eight tokens went on thinking, `content` came back empty, and `readVerdict('')` fell through to `ask` - which from the gate's side is indistinguishable from a model that considered the command and declined it.

The path is easy to land on rather than exotic.
`classifierModel` defaults to `null` and falls through to the **coding** model:

```ts
const model = a.classifierModel ?? a.coding.model;
```

which is by definition the strongest model the user picked, and increasingly always a reasoning model.

The same shape was latent in `resolveTitle` (24 tokens) and `generateSummary` (32 tokens).
Neither would have errored either; a session would just never get a name.

## The two traps

**`reasoning: null` does not mean "off".** In `streamCompletion` the parameter is spread conditionally:

```ts
...(req.reasoning === null ? {} : { reasoning: req.reasoning })
```

so `null` means *omit the parameter*, which leaves the model's default in place.
The obvious-looking fix - pass `reasoning: null` from the classifier - would have changed nothing at all.
Turning reasoning off takes an explicit `{ enabled: false }`.

**Some models will not turn it off.** OpenRouter's `/api/v1/models` reports a per-model `reasoning.mandatory`, documented as *"when true, reasoning cannot be disabled and effort `none` is rejected"*.
On those, `{ enabled: false }` is refused and the thinking happens regardless.
So the parameter alone is not a complete fix - the token budget has to leave room for the word to arrive *after* the thinking, which is why `MAX_TOKENS` went from 8 to 512.

## The fix

Three parts, and it needed all three:

1. `CompletionRequest` gained `reasoning`, spread into the body exactly as `streamCompletion` already did. It is **required**, not optional with a default, so the compiler made all three short-completion callers state an answer.
2. All three pass `{ enabled: false }`.
3. `readVerdict` reports an empty answer as `null` - "no answer" - rather than as `ask`, so a model that thought instead of answering is not recorded as having judged the command. That fed the separate cache fix in the permission gate.

## What to take from this

- **A conditional spread makes `null` mean "unspecified", not "off".** Those are opposite intentions and the type cannot tell them apart. When both are real options, the absent case deserves a comment at the type - which is what `CompletionRequest.reasoning` now carries.
- **Check `mandatory` before assuming a capability can be switched off.** Reading the provider's model metadata answered in one query what the code could not.
- **A tiny `max_tokens` is a bet that the model spends nothing before answering.** That bet is now wrong by default on the strongest models, and it fails as empty content rather than as an error.
- **Empty is not a verdict.** Any parser that folds "said nothing" into a real answer loses the distinction its caller needs - here, whether the answer was worth caching.
