# A resumed Claude Code member's earlier cost was counted as money

Date: 2026-10-18
Found while: running j20 on Claude Code crew paid by the subscription

## What happened

The job's Spend showed $1.57 of money on a Claude Code builder, and 0% of the Claude sub.
Fleet restarted while the builder worked, and a hire for the step resumed its session with `--resume`.
The resume is a new crew member with no billing and no cost seen yet.
Its first status line showed the conversation's cost so far, $1.57, with no subscription windows, because no reply had come yet.
`sessionCost` read "a cost and no windows" as Claude Code on an API key, and counted all $1.57 as money.

## Fix

`costBefore` starts a member that resumed the same session from the billing and cost of the member it took over.
The restored cost is then no rise, and the billing stays `subscription`.

## Rule

A guess made from the first report of a session is only safe for a fresh session.
A resumed session carries state from before, so carry the earlier member's state over too.
