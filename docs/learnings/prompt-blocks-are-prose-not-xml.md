# Learnings: Fleet's prompt blocks are prose, not XML (2026-08-10)

Written after building the Agent pane's environment block, where I got the framing wrong first and had to redo it.

## What happened

The task was to tell the agent what machine it is on - platform, shell, OS version, git-or-not, timezone - plus the current time.
I read how the other harnesses do it, and all three wrap it in a tag:

- Claude Code: `<env>Working directory: … Platform: … Today's date: …</env>`
- opencode (`session/system.ts`): the same `<env>` block, near-identical fields
- Codex (`core/src/context/world_state/environment.rs`): `<environment_context><cwd>…</cwd><shell>…</shell></environment_context>`

So I wrote an `<env>` block, plus a per-turn `<env>Current time: …</env>` message, plus a sentence in the system prompt explaining what the tag meant.

All of it was wrong for this codebase, and the reason was already written down in `agent-service.ts` next to `FLEET_WIRE_PREFIX`:

> Said plainly instead of wrapped in a tag. `<system-reminder>` is a house style of one harness and one provider; here the same turn may be answered by any model OpenRouter routes to, and a tag one of them has never seen is either ignored or read out loud.
>
> The same words for every reminder, so a round carrying two of them does not appear to have two different things talking to the model.

Both clauses bite. Fleet is not talking to one model - it is talking to whatever OpenRouter routes the turn to, and `<env>` is not a convention those models share.
And a single round can already carry a task list, a subagent roster and a schedule, all introduced by `Note from Fleet, not from the user:`.
Adding a clock under a different framing would have made that round look like two separate things addressing the model, one of them unnamed.

## The house style, for the next block

Every block Fleet assembles follows the same shape: a sentence naming what this is, a blank line, then the content, indented if it is a list of fields. No tags anywhere in the prompt path.

- `renderProjectInstructions` - "Instructions from AGENTS.md, the project's own file…", then the file
- `renderTodoBlock` - "Your task list for this conversation, as it stands right now:", then the items
- `renderEnvBlock` - "Here is what Fleet knows about the machine you are running on:", then the fields

And the division of labour: **shared renderers return the bare block, and the caller in main adds `FLEET_WIRE_PREFIX`.**
`renderTodoBlock`, `renderScheduleBlock` and now `renderTimeBlock` all work this way; `withTodoReminder` and `wireTime` are where the prefix goes on.
Putting the prefix inside the shared renderer would have worked and would have been subtly off-pattern.

## The general lesson

Researching how other harnesses solve a problem is worth doing - the *content* of the env block came straight from that research, and the fields the three of them independently agree on are the right fields.
What does not transfer is house style. Claude Code can use `<system-reminder>` because Claude Code talks to Claude. Fleet cannot.

Read the codebase's existing convention before importing a convention from outside it, and when a comment in the codebase has already reasoned about the exact question, that reasoning wins.
`grep` for a nearby constant's doc comment is cheaper than a rewrite.

## The one design point worth keeping

Independent of framing, the split that made the feature work: **static machine facts go in the system prompt, the clock goes in a message at the tail.**

The system message is the request's cache prefix. A timestamp there rewrites the prefix on every round - a forty-round turn pays full rate forty times - and it is stale anyway, because the system prompt is built once per turn while a turn can run for an hour.
Immediately before the newest user message, the clock sits in the region that is re-sent uncached regardless, so the accurate answer is also the free one.

Codex reached this from the other direction (`current_time_reminder.rs`, a per-turn developer-role fragment), Claude Code sends its date as a reminder on the user turn rather than in its environment block, and the Agent SDK exposes `excludeDynamicSections` to move per-session context out of the system prompt for exactly this reason.
