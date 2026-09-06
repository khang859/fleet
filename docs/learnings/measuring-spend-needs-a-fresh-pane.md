# A spend measurement needs a fresh pane, not a new session

## What happened

Issue #563 asks for the incremental saving from prompt cache breakpoints to be measured rather than assumed.
The obvious way to do it is one turn with caching on and one with caching off, same prompt, same model, comparing what the pane reports.

I ran both turns in the same pane, calling `startNewSession` between them to clear the transcript.
The second run reported `cachedTokens: 43,617` and `cacheWriteTokens: 33,730` with caching switched off, which is impossible: with no `cache_control` markers in the request there is nothing to write and nothing to read.

The tell was `calls`, which went from 5 to 10 rather than back to 0.

## Why

`startNewSession` clears the conversation. It does not reset the pane's spend meter.
The meter is cumulative for the life of the pane, so the second reading was the sum of both runs, and the "impossible" cached tokens were the first run's.

There was a second confound underneath the first: the thread still reported `msgs: 8`, so the second run also carried the earlier transcript, which is why its prompt tokens were roughly triple.

## The fix

Use two panes that have never been used, one per arm, and read each pane's own `spend`.

```
npm run drive -- eval 'const a=__FLEET__.stores.agent.getState(); JSON.stringify(Object.entries(a.threads).map(([k,t])=>({k,calls:t.spend.calls,msgs:t.messages.length})))'
```

A pane reporting `calls: 0` and `msgs: 0` is a clean arm.
Run the off arm first so the on arm starts against a cold provider cache.

Done that way the numbers came out sane, and the off arm reported exactly `cachedTokens: 0, cacheWriteTokens: 0` - which is itself the check that the breakpoints really were suppressed.

## The rule

Before trusting any before/after number this app reports, confirm the counter you are reading actually resets between the arms.
When it does not, isolate the arms instead of resetting them.
`calls` is the cheapest tell: if it does not start at zero, the reading is a sum.
