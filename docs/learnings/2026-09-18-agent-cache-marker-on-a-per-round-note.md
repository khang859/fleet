# Agent turns got slower every round: the cache marker sat on a note that is gone next round

## Symptom

In a long agent turn, each tool call seemed slower than the one before.
Late in a turn, a plain `ls` could take minutes to show up and finish.

## What was actually slow

Not the tool.
Every `bash` result in the saved sessions says how long the command ran, and none of them took minutes (`ls` was 0.0s).
The wait was the model round between calls.

The session logs showed why.
One session: 11.26M prompt tokens, 11.23M cache-write tokens, 7K cache-read tokens.
The cache was written on every round and never read back.
So every round re-processed the whole transcript at full price, and a longer transcript meant a slower round.

## Cause 1: the end-of-request marker landed on a per-round note

`withCacheBreakpoints` put the second `cache_control` marker on the last message of the request.
But `runRounds` appends notes after the conversation on every round: the task-list block (sent even with an empty list, as a nudge), the subagent roster, the schedule block, the resume note.
They are left off the next round.

Anthropic writes a cache entry only where a marker is.
The entry written at the note has a prefix no later request sends, so it is never read.
Only the system-prompt marker ever hit.

Fix: `StreamRequest.cacheUpTo` says how many messages are the conversation.
`runRounds` passes the length before the notes, and the marker goes on the last conversation message.

## Cause 2: result clearing moved its line every round

Once a turn had more than `CLEAR_KEEP_RECENT` results and `CLEAR_MIN_TOKENS` to gain, every round cleared all older reproducible results.
The recent window slides by one call per round, so the cleared set grew by one each round.
That rewrote the transcript at a new place every round, and the cache after that place was lost every round.

Fix: `clearedPrefix` walks the older results from the start and moves the line only when another `CLEAR_MIN_TOKENS` has piled up behind it.
It is stateless, so the pane and the wire, and every round, reach the same line.

## How it was found

- Timed tool start/end events in the renderer: tools ran in 8-19ms, the gaps between them were the model.
- Read the `spend` totals in `~/.fleet/agent/sessions/*.jsonl`: sessions on providers that need markers had write ≈ prompt and read ≈ 0.
- Providers that cache on their own (DeepSeek) had high reads and no writes, which is why it only showed on some models.

## Lesson

A cache marker must go on something the next request sends again.
Anything that is recomputed per request belongs after the marker, and anything that rewrites the middle of the transcript should move rarely, in steps.

## Follow-up: the pane made fast steps look hung

After the cache fix, a live chat still looked stuck.
Timed events showed 3 waits that the pane did not name:

- Auto mode's permission check ran between tool start and tool end, so a 0.0s command showed 1-5s as run time.
- Reasoning in later rounds was hidden, and the status said "Thinking".
- The model wrote tool-call arguments for 6-8s with no sign on screen.

The status clock also counted from the start of the turn, so every wait looked minutes long.

A timed-out check (20s) was not remembered, so each later command in the turn waited 20s again.

Fixes:

- `AGENT_STREAM_STEP` tells the pane `drafting` (first tool-call fragment of a round), `checking` (auto-mode model asked) and `running` (model said yes).
- The store keeps `step: { phase, since }` per turn, and the status line shows that phase with a clock for that step only.
- The gate stops asking the model for the rest of a turn after one failure that took 5s or more; a fast failure (a 502) is still tried again.

Lesson: a status line must name every wait the user can sit through, and its clock must count the wait, not the turn.
