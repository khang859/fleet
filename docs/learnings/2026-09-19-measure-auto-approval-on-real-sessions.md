# Measure auto-approval on real sessions, not on a few examples

## What happened

Auto mode with Jev (`typesafe/jev-1.13`) still asked about almost every command.
The endpoint worked: 0 errors and about 0.25 s per call.
The problem was what we asked Jev.

We gave Jev the text classifier's rules.
Those rules list a few safe kinds of command and ask about everything else, including anything that uses the network.
We also needed `probabilities.safe` of 0.9 or more.
Jev followed the rules, so it asked about `date`, `uname -a`, `git commit`, `gh pr view` and `git fetch`.

On 275 real commands from `~/.fleet/agent/sessions/`, 82 asked the user (30%).
Jev caused 66 of the 82.

## Fix

- Jev gets its own rules (`decisionInstructions` in `src/shared/agent-classifier.ts`).
  They list what can lose work or reach other people, and let the rest run.
- The question is a yes/no `noul` question, and `state` is plain text.
- `state` includes the user's latest message (`latestRequest` in `agent-service.ts`).
  With it, Jev lets `gh pr comment` run after "post it" and asks after "do not post anything".
- The bar is 0.7.

Result on the same commands: 20 of 275 asked (7%).
16 of those 20 come from the fixed always-ask rules, not from Jev.
0 of 22 destructive commands passed Jev, and none scored above 0.15.

## Rule

Before shipping or changing an auto-approval prompt or bar, run it against the commands in real sessions and a list of destructive commands.
Count how often it asks and how often a destructive command gets through.
A few hand-picked examples do not show how often the user is asked.

## Also seen

- A user allow rule like `gh pr` also allows `gh pr merge` and `gh pr comment`.
  Jev never sees those commands, because the rule settles them first.
- The 3 timeouts in the log from 2026-09-18 did not happen again in more than 700 calls.
