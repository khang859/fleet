# A predicate answerer kept held permission hooks open

## What happened

Phase 5 let an answerer of permission requests pass a `canAnswer` predicate, so the Orchestrator counts as one only while its setting is on and a pane is orchestrating.
Main registers that answerer once, at startup, and never removes it.

Held hooks were released only when the last answerer unregistered (`answerers.size === 0`).
With the Orchestrator's answerer always registered, that never happened again:

- Turning the copilot off while it held a hook left the hook open for up to 310 s, although the Orchestrator's predicate said it could not answer.
- Turning "Orchestrator answers permissions" off, or leaving orchestrator mode, left hooks held that nobody could answer any more.

A hook nobody answers stalls a background subagent, whose permission dialog waits on the hook.
A bug review caught it; no test covered the copilot leaving while another answerer stayed.

## Fix

`ClaudeSessionsService.releaseUnanswerable()` releases every held hook when no answerer's predicate is true.
It runs when an answerer unregisters, when a conversation leaves orchestrator mode, and when the Orchestrator setting is saved.
Checked end to end: with a request held and the Orchestrator's card up, turning the setting off made the hook process exit while Claude Code's own prompt stayed up, and a late "Allow it" was told the request had gone.

## Lesson

When a registration becomes conditional, every place that asked "is anyone registered?" has to ask "can anyone still act?" instead.
A decision made once, as each request arrives, also has to be made again when what it read changes.
