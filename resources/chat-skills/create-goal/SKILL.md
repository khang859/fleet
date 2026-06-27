---
name: create-goal
description: >-
  Turn a rough idea into a structured goal document saved to docs/goals/YYYY-MM-DD-<slug>.md. Use when the user wants to "create a goal", "define an objective", "scope this work", "write up a goal", or turn a vague idea into something concrete with success criteria. Pass the idea as the argument. Examples: /skill:create-goal, /create-goal add dark mode to settings, /create-goal cut cold-start time in half.
---

# Create Goal

Your job is to turn the user's idea into a clear, structured goal document and
save it to disk. The output is a markdown file the user (or another agent) can
later turn into a plan or a swarm. Do not start implementing the idea — define
it.

This skill assumes the user is running you inside a working tree. If you cannot
write to `docs/goals/`, tell the user and stop.

## Inputs

- **The idea.** The text the user typed after the invocation (shown as
  `User: <arg>` below). If it is empty, ask one question: "What's the goal?"
  and wait for an answer before continuing.

## Protocol

Three phases, in order.

### Phase 1 — Understand

Read the idea. Restate the intended outcome to yourself in one sentence. If that
sentence is already clear and the success criteria are obvious, skip straight to
Phase 3 — do not interrogate a well-specified request.

### Phase 2 — Clarify (only when essentials are missing)

Ask focused questions, one at a time, ONLY for essentials you cannot reasonably
infer:

- **Purpose / who it's for** — why this matters, who benefits.
- **Success criteria** — how we'll know it's done, stated as verifiable checks.
- **Hard constraints** — deadlines, tech limits, things that must not change.
- **Non-goals** — what is explicitly out of scope.

Stop asking as soon as you can write a useful goal. Two or three questions is
usually plenty; never run a long interview.

### Phase 3 — Write

Pick a short kebab-case slug from the goal (e.g. `dark-mode-settings`,
`cold-start-speedup`). Compute the path `docs/goals/YYYY-MM-DD-<slug>.md` where
the date is today (use the injected time context, or call get_current_time if
unsure). If that path already exists, append `-2`, `-3`, … until unique.

Use the `write_file` tool to save the document in the exact shape below. Then
tell the user — in chat — the absolute path you wrote and a one-line summary of
the objective.

## Goal document format

Match this shape exactly. Omit a section only if it genuinely has no content.

```markdown
# <Goal title>

**Date:** YYYY-MM-DD

## Context
<Why this goal exists; the background a fresh reader needs. 2-4 sentences.>

## Objective
<One clear sentence stating the outcome.>

## Success criteria
- <Verifiable check — something you could test or observe.>
- <Verifiable check.>

## Constraints
- <Hard requirement or limitation. Omit the section if there are none.>

## Out of scope
- <Something this goal explicitly does not cover.>

## Suggested first steps
1. <Concrete starting action.>
2. <Concrete starting action.>
```

## What makes a good goal

- The objective is a single sentence describing an outcome, not a task list.
- Success criteria are verifiable ("p95 cold start < 800ms"), not vague
  ("feels faster").
- Out-of-scope is explicit — it's what keeps the goal from sprawling.
- First steps are concrete enough that someone could start tomorrow.

## What to skip

- Do not implement the idea or write code.
- Do not create kanban cards, swarms, or branches — this skill only writes a doc.
- Do not pad the document with filler; an empty section is better than guessed
  content.
