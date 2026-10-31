# Removing a feature left code that still looked live

## What happened

Removing the Orchestrator looked finished once the compiler and `ripwire . --quality-delta` found no dead code.
Three pieces survived those checks, because each one still had a caller:

- `BriefBuilder` and `EvaTranscripts` were fed on every hook event, but only the Orchestrator's `read()` used what they built.
- `TranscriptTail` kept its turn and tool indexes up to date, and nothing read them any more.
- `addPermissionAnswerer` kept its `canAnswer` predicate, and only tests still passed one.

A dead-code check sees a symbol with a caller as alive.
It cannot see that a value is computed and then never read, or that a parameter always takes its default.

## How it was fixed

Each piece was traced from the consumer that was removed, back to what fed it, and then deleted.
`addPermissionAnswerer` went back to its simple rule: when the last answerer leaves, release every held hook.

## How to avoid it

After removing a feature, list what it consumed, and check who else reads each value.
Look for optional parameters that only tests pass.
A clean dead-code report does not prove that a removal is finished.
