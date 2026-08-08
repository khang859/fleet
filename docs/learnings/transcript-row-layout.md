# Where a tool row's summary goes

Date: 2026-08-07
Found while: adding the `skill` tool to the Agent pane

## What happened

The `skill` tool had no case in `tool-label.ts`, so it fell through to the
default label - `{ verb: call.name, target: '' }`. Combined with a summary of
`definition.name`, the transcript row rendered as:

```
> skill                                                        verify-e2e
```

The tool's own name on the left, nothing beside it, and the one thing the call
was actually about stranded ~1000px away at the right edge of the pane.
Fixing the label alone made it worse, not better:

```
> Load skill verify-e2e                                        verify-e2e
```

Same word at both ends of a dead gulf.

## Two separate faults

**1. The summary column is for an outcome, not an identity.** Every other tool
follows this - `14 lines`, `3 files`, `+12 -3`, `no matches`, `exit 1`. The
skill tool was putting the subject of the call there, which left the target
slot empty and forced the reader's eye across the whole pane to find out what
had been loaded. The subject belongs next to the verb; the summary says how
much came back.

**2. `ml-auto` assumes a card, and the transcript is not one.** Checking how
other products draw this (v0, ChatGPT, Zapier Central, Base44) - in every case
the right-aligned status sits at the right edge of a **bounded card**, roughly
200-500px wide. Nobody right-aligns across a full-width pane. At Fleet's
widths the two ends stop reading as one row and become two unrelated things.

Dropping `ml-auto` so the summary sits directly after the target fixes it
without restyling the transcript. The target keeps `truncate`, so a long path
still absorbs the width and the summary stays visible:

```
> Load skill verify-e2e 8 lines
> Load skill verify-e2e/references/codeword.md 2 lines
```

## The general rule

A new tool needs a `tool-label.ts` case. Falling through to the default is not
a neutral default - it prints the wire name of the tool as though it were a
verb and drops the subject entirely, and whatever went into `summary` gets
flung to the far edge to compensate.
