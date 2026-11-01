# Workflows: Post sent a finding that the report dropped

## What happened

On PR #742, the lead reviewer dropped the only Nit in its report.
The report said "Nits: None", but Post still sent that Nit to the PR.

## Why

The report and the board were two records of the same review.
The lead wrote its decision in the report, but it had no tool to remove a board item.
Post read the board, so it sent what the lead had dropped.

## Fix

Post now sends the final report as one PR comment.
Fleet main runs `gh` directly, so the post agent pane, `fleet_post_item` and the per-item post marks are gone.
A hidden `fleet:report:<runId>` mark on the PR stops a second comment after a lost answer.
An incomplete report cannot be posted.

## Rule

When one action shows a person some text, send that same text.
Do not rebuild it from a second record that can disagree.
