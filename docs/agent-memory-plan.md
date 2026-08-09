# Agent pane memory and `/refine` - Implementation Plan

> **Status:** designed, not implemented. Awaiting review.
> **Written:** 2026-08-09, against `ab19fd5e`.
> **Origin:** Prime Intellect's [prime-agent post](https://www.primeintellect.ai/blog/prime-agent), read for whatever the Agent pane could take from it.
> **Implementer's brief:** `docs/agent-memory-handoff.md`. This document is the decision; that one is the execution. If the build proves something here wrong, amend this file rather than letting the two drift.
>
> Requirements are locked (section 3), the architecture is chosen (section 6), and the build order is section 11.
> Three independent architecture proposals were produced and reconciled; where they disagreed, section 5 records which one won and why.

## 1. What this is

A way for the Agent pane to carry what it learned in one session into the next.

Today it cannot.
Every conversation starts from the same static system prompt: a base paragraph, a block per capability that happens to be switched on, and the working folder.
Nothing in it is about this repository, this user, or anything a previous session found out the hard way.
A correction the user made yesterday costs them the same correction today, and the third time it costs them the patience to keep making it.

Two things, which are one feature:

- **Memory.** Markdown files under `.fleet/memory/`, discovered the way subagents, commands and skills already are, disclosed progressively the way skills are, and written by the agent itself.
- **`/refine`.** A command that looks back over the conversation it is run in and writes down the one thing worth keeping, if there is one.

Plus a third thing that shares all the same machinery and is embarrassing to be without: **reading `AGENTS.md`**.
Fleet reads no project instruction file at all.
Every other coding agent honours one, most repositories already have one, and this repository has a `CLAUDE.md` that the Agent pane cannot see.

### Goals

- A fact learned in one session is in front of the agent in the next one, without the user restating it.
- The agent decides what is worth keeping, and a person can see every such decision and undo it.
- Fleet honours the project instruction file the rest of the ecosystem already honours.

### Non-goals

Stated here rather than at the end, because these are the questions a reader will otherwise ask all the way through, and because they are the boundary of what the implementer is being asked to build.

- **Not a knowledge base.** No similarity search before a write to catch a near-duplicate the roster did not, no embedding index, no retrieval beyond a name in an `enum`.
- **No staleness detection.** Nothing re-checks an entry against the code it describes. `/refine` verifies a claim before writing it, and after that an entry is true until a person says otherwise. Automated freshness is a subsystem of its own.
- **No rollback beyond Remove.** No revision history, no refinement ids, no undo stack. Section 6.8 says why.
- **No recursive `AGENTS.md` discovery** up the tree or beside the file being edited. The working folder's file, or nothing.
- **No importing memory from another tool's format**, and no `references/` or `scripts/` written through `skill_write`.
- **No scheduled or automatic `/refine`.** It runs when a person asks for it.
- **Three things from Prime Agent deliberately not built:** the two-phase plan-then-apply pipeline, the editable-subagent surface, and rollback by refinement id. Section 5 and section 6.5 give the reasoning for each.

## 2. What other harnesses do

Research findings, recorded because they shaped the decisions below.

**Prime Intellect's Prime Agent** is where this idea came from, and it is the most ambitious version of it.
Its "continual harness" models the whole harness state as `H=(ρ,G,K,M)` - prompt, subagents, skills, memory - and exposes one CRUD surface over all four: `create_memory`, `create_skill`, `create_prompt_note`, `create_subagent`, each with `update_`/`delete_`/`list` alongside.
`/refine` reads the agent's own trajectory and "applies the smallest relevant CRUD edit", running in two phases: a background planning call that proposes the edit, then a fast apply that writes to disk and rebuilds the system prompt.
The base system prompt stays immutable; only the harness layer around it is editable.
Each refinement records its trigger and its outcome, "so improvement is evidence-backed rather than arbitrary".

Three things about that design do not transfer, and section 5 explains why in detail: the two-phase async pipeline, the editable-subagent surface, and the rollback-by-refinement-id history.

**Claude Code** reads `CLAUDE.md` from the working folder and up the tree, always in the system prompt, never progressively disclosed.
It also has a memory tool that writes to a directory of one-fact-per-file markdown, each with frontmatter, and an index file loaded every session.
The split is instructive: standing project instructions are unconditional, and learned facts are indexed by a one-line description with the body fetched on demand.
This plan takes exactly that split.

**Cursor** has `.cursorrules` and now `AGENTS.md`; **OpenCode**, **Codex CLI** and **Aider** all read `AGENTS.md`.
`AGENTS.md` is the closest thing to a standard that exists, which is why it wins over `CLAUDE.md` in section 6 rather than being merged with it.

## 3. Locked requirements

Settled with the user across two rounds of questions.
**Do not reopen any of them.**
If you believe one is wrong, say so and stop, rather than quietly building something else.

1. Memory entries are flat markdown files with YAML frontmatter, from two tiers: project (`<cwd>/.fleet/memory/`) and user (`~/.fleet/memory/`), most specific winning a repeated name.
   There is no bundled tier, because Fleet ships no memory.
2. **Progressive disclosure, skill-style.**
   Each entry's name and one-line description go in the `memory` tool's own description, so the headlines are in front of the model every round; the body is fetched only by a call.
3. **The agent may write memory silently mid-turn.**
   No permission card. A write is an ordinary tool row in the transcript, and the user sees and undoes it from a list in the Agent pane's Settings tab.
4. **`/refine` is a bundled markdown command file**, not a builtin turn with its own tool list.
   Its edit surface is memory entries and skills, and the boundary keeping skill writes to `/refine` is the tool description's wording rather than the type system.
5. **`AGENTS.md` is read from the working folder**, falling back to `CLAUDE.md`, and injected into the system prompt unconditionally.
   **It is never truncated.**
   Past 20,000 estimated tokens the user is warned, and the whole file is still sent.

Two further decisions were taken during architecture and are locked with the same force:

6. **The model gets no delete tool**, for memory or for skills.
   It may overwrite an entry by name, which is how a wrong one gets corrected.
   Removal is a human action in Settings only.
7. **Subagents may read memory and may not write it.**

## 4. What the codebase already provides

Almost all of it. This is a feature assembled from parts that exist.

| What is needed | What already does it |
| :-- | :-- |
| Three-tier on-disk definition walk | `markdown-definitions.ts:70` `loadDefinitions`, used unchanged |
| Progressive disclosure into a tool description | `agent-skills.ts:191` `buildSkillSpec`, mirrored |
| A framing header around text from a file | `agent-skills.ts:246` `renderSkill`, mirrored |
| Silent writes with no permission card | `write`/`edit` already are; only `bash` and MCP calls ask |
| Refusing to overwrite a file the model has not read | `tools/freshness.ts` `remember`/`requireFresh`, keyed by `(threadId, path)` |
| Showing what a write changed | `tools/edit.ts:65` `diffReport` |
| Confinement against a root that is not `cwd` | `tools/paths.ts:76` `resolveInsideCwd(target, root)`, already called by `tools/skill.ts:76` with a skill's own folder |
| A slash command that is only a file | `commands/expand.ts:22` `expandCommand`, plus `resources/commands/*.md` |
| A settings list of file-backed things with reveal and remove | `settings/skills/SkillsSection.tsx`, `store/agent-skills-store.ts` |
| Per-turn on-disk loads at the top of a turn | `agent-service.ts:846` loads skills and subagents |

Four properties of the existing design are load-bearing for what follows.

**Main is stateless and the pane resends the whole history every turn.**
`agent-types.ts:389` states it: the transcript lives in the renderer and is sent whole with each turn.
This is why `/refine` needs no mechanism at all to "read the session's own trajectory" - by the time the command's prompt reaches the model, the trajectory is already the conversation it is sitting in.

**Nothing caches.**
`markdown-definitions.ts:30` states it: the file is the interface, and a cache would make freshness a question about when Fleet last looked rather than about what the file says.
Memory inherits this, which is what makes a write in round 2 of a turn visible to the next turn with no invalidation step.

**A tool a folder has nothing for is not offered.**
`buildSkillSpec` returns `null` on an empty roster, and `toolSpecsFor` drops it, because a tool whose every call is an apology is a round the model wastes.
Memory breaks this rule deliberately, and section 6.3 says why.

**`AGENT_TOOL_NAMES` is `SUBAGENT_TOOL_NAMES` plus four.**
`agent-tools.ts:78` builds the wider list from the narrower one, so the list that has to be maintained is the longer one.
Adding a tool to `SUBAGENT_TOOL_NAMES` gives it to both; adding it to the spread instead gives it to the pane only.
That is the whole mechanism for requirement 7, and it costs one line.

## 5. The three proposals, and what was taken from each

Three architectures were produced independently: one optimising for the smallest diff, one for long-term maintainability, one for whether the feature would actually make the agent better rather than worse.
They agreed on the skeleton - flat files, two tiers, `buildSkillSpec` mirrored, freshness on overwrite, the transcript as the audit trail, `AGENTS.md` over `CLAUDE.md` with no merge.
They disagreed on four things.

**`/refine` as a command file versus a first-class turn.**
The clean-architecture proposal made `/refine` a builtin: its own system prompt, a six-tool allow-list enforced centrally in `run.ts`, a new `AgentMessage.role: 'refine'`, a widened session-log role enum, a composer builtin and a transcript pill.
That buys one real thing, which is that `skill_write` becomes structurally unreachable outside `/refine` because it never enters `AGENT_TOOL_NAMES` at all.
It costs a new turn path in `AgentService`, a schema change to the session log, and renderer work, for a feature whose entire value is in what the model writes rather than in how the turn is framed.
**Taken: the command file.**
Requirement 4 locks it.
The boundary is instructional, and section 14 records honestly what that leaves open.

**How the skill-write boundary is enforced.**
The pragmatic proposal kept the command file but gated `skill_write` structurally anyway, by checking in `turn()` whether `req.text` parses as `/refine` and only then providing the capability.
**Rejected outright.**
It decides a capability by sniffing a string, it breaks the moment a project-tier `refine.md` overrides the bundled one or the command is renamed, and it fails open rather than closed: a message that merely looks like a refine grants the tool.
A guard that is wrong in the permissive direction is worse than no guard, because it reads as protection to everyone who sees it.

**Whether the model may delete.**
Two proposals gave it `memory_delete` and `skill_delete`; one gave it neither and argued that handing a model the power to quietly erase the record of its own mistake is a strictly worse failure mode than a stale entry sitting there until somebody prunes it.
**Taken: no delete tool**, now locked as requirement 6.
The counter-argument - that delete is the release valve against a roster that grows forever - is answered by overwrite plus the Settings list.
Overwrite already covers the case that matters, which is an entry that turned out to be wrong.
Pruning for size is curation, and curation is a human act.

**The write primitive.**
Two proposals wrote the file directly with `yaml.stringify` and a template literal.
The clean-architecture proposal wrapped it: serialize, then parse the result back through the same schema the *reader* uses, and only then land it via temp file and `rename`.
**Taken, and it is the single best idea in any of the three.**
`docs/learnings/2026-04-28-pi-skill-frontmatter-yaml.md` is exactly this bug already happening once: a description containing `": "` broke YAML parsing.
A memory the writer cannot read back does not fail loudly.
It is skipped by `readOne` with a `log.warn` nobody sees, and the agent goes on believing it wrote something.

Two smaller reconciliations:

- **Caps.** Description capped at 200 characters, taken from the clean proposal, because unlike a skill's roster this text rides on every round of every turn whether or not any entry is relevant today.
  Body capped at 4,000 characters, taken from the pragmatic proposal, because a memory is a note and something longer is a skill.
  **No cap on entry count**, taken from the clean proposal's reasoning: a hard ceiling creates a cliff where the agent is silently unable to record something true because the folder is full, which is a worse failure for a feature meant to compound over a year than a roster that grows slowly and has two people able to trim it.
- **Subagents.** Two proposals gave them read-only memory; one put memory writes on the same footing as `edit`/`write`.
  **Taken: read only.**
  A subagent starts from nothing, sees none of the conversation, and reports back once, so a fact it records has no provenance a later turn could weigh.
  The parent reads the child's report and, if it is worth keeping, writes it itself.

## 6. Chosen architecture

Every subsection is tagged, because two very different kinds of decision are interleaved here and they read identically on the page.
**Locked** follows from a requirement in section 3 and is not the implementer's to change.
**Author's call** was decided while designing this: it is the part worth arguing with, and overturning it costs nothing but the argument.

### 6.1 Memory on disk

*Locked: flat markdown with frontmatter, the two tiers, most-specific-wins (requirement 1). Author's call: the strict schema and the filename-equals-`name` rule.*

`<name>.md` under `.fleet/memory/`, in the project folder or in `~`.
Frontmatter is `{ name, description }`, strictly - `z.object`, not `z.looseObject`.
`SkillFrontmatter` is loose because `SKILL.md` is an open format other tools also write and an unknown field there is an extension to tolerate.
Nothing else reads this format, so an unknown field here is a bug in whatever wrote it.

The filename must equal the frontmatter `name`, and a file where they disagree is skipped with a warning.
Subagents and commands have no such rule and do not need one, because nothing writes them by name.
`memory_write` addresses an entry by `name` alone and needs a deterministic path to write to without a scan; without the rule, a hand-written `notes.md` containing `name: foo` and a later `memory_write({name: "foo"})` producing `foo.md` would leave two files racing for one name, resolved by whichever `readdir` returns last.

Reading is `loadDefinitions` unchanged, sources `[['user', ...], ['project', ...]]`, project last so it wins.

### 6.2 Progressive disclosure

*Locked: progressive disclosure, skill-style (requirement 2). Author's call: putting the names in an `enum`.*

`buildMemorySpec(entries)` mirrors `buildSkillSpec`: the roster goes in the tool's description, the names go in an `enum` so a name the schema will not accept is a name the model cannot spend a round guessing wrong, and the body arrives only on a call.

### 6.3 The one place memory departs from skills

*Author's call, in full.*

`buildSkillSpec` returns `null` for an empty folder and the tool is not offered.
`memory_write` is offered even when there are no entries, because memory has to be writable into existence.
An empty roster is not "every call would come back an apology", it is "the first call creates the first entry", and those are opposite situations that happen to look alike.

`memory` (the read tool) keeps the `null` rule: with nothing to read, there is nothing to read.

### 6.4 Writing

*Locked: silent mid-turn writes with no permission card (requirement 3), no delete tool (requirement 6). Author's call: the round-tripping write primitive, freshness-on-overwrite, and sharing one primitive with skills.*

One shared primitive, `writeFrontmatterFile(path, frontmatter, body, schema)`, in a new `markdown-definitions-write.ts` beside the read-only walk.
It serializes with `yaml`'s own `stringify` - never a hand-built template, per the learnings file above - parses the result back through the reader's schema, throws before touching disk if the round trip fails, then writes to a temp file and `rename`s it into place.
`schedule-store.ts:343` already uses temp-then-rename for the same reason.

Around it, `writeMemoryEntry` applies the rule `write.ts` already applies to source files:

- the file does not exist: write it, no freshness check, report "created";
- the file exists: `requireFresh(threadId, path, ...)`, write it, `remember(...)`, report a `diffReport`.

So an entry can be created freely and can only be replaced by an agent that has read it in this conversation.
`runMemoryRead` calls `remember` on a hit, so reading an entry and then correcting it works in one turn without a second read.

The same primitive backs `writeSkillBody`, targeting `<root>/<name>/SKILL.md`, where `root` is `<cwd>/.fleet/skills` or `userSkillsDir()`.
This is the answer to "user-tier skills live outside `write`'s confinement": the tool resolves against the tier's own root using `resolveInsideCwd`, exactly as `tools/skill.ts:76` already resolves a bundled file against the skill's own folder.
`resolveInsideCwd` is not `cwd`-specific; the parameter is called `cwd` but it is a root.

### 6.5 `/refine`

*Locked: a bundled markdown command file, editing memory and skills (requirement 4). Author's call: dropping Prime Agent's two-phase pipeline, and treating the transcript as the evidence record.*

`resources/commands/refine.md`, and nothing else.

`expandCommand` replaces the `/refine` line with the file's body on the way to the wire, keeping the one-line `/refine` in the transcript and in Up-arrow recall.
The model receives the prompt with the entire conversation already behind it, because main is stateless and the pane resends everything.
That is the whole implementation of "reads the agent's own trajectory".

Prime Agent's two-phase plan-then-apply pipeline is deliberately not built.
It exists there so a proposing call does not block an ongoing conversation, which is a real problem in a harness built around concurrent long-running subordinate work.
Fleet's pane runs one turn at a time and `/refine` is something the user asked for right now, so there is no ongoing conversation to avoid blocking.
Collapsing propose and apply into one ordinary turn removes a scheduling subsystem, a plan-storage format and an apply-at-boundary path, and loses nothing.

Evidence is the transcript.
Prime Agent keeps a dedicated record of each refinement's trigger and outcome; here that record is the turn itself - the tool rows showing what was written, the diff on an overwrite, and the model's closing report saying what in the session justified it.
The `/refine` prompt requires that report, which is what makes the evidence exist rather than a schema field that would.

### 6.6 `AGENTS.md`

*Locked: read from the working folder, `CLAUDE.md` as fallback, unconditional, never truncated, warned past 20,000 tokens (requirement 5). Author's call: no merge when both exist, where in the prompt it goes, giving it to subagents too, and counting with `estimateTokens` rather than a real tokenizer.*

`loadProjectInstructions(cwd)` tries `AGENTS.md`, falls back to `CLAUDE.md`, returns `null` when neither is there.
No merge: `AGENTS.md` wins outright when both exist.
A merge would mean deciding what to do about two files that contradict each other, and the honest answer is that the project already decided by having both.

**Never truncated.**
The whole file goes into the prompt however long it is.

This is the one place where the obvious safety measure is the wrong one.
A cap on a tool result is fine because the model can ask for the rest; a cap on the project's standing instructions is a silent, permanent removal of rules the project wrote down expecting them to be followed.
Cutting at 20,000 characters means whatever was written at character 20,001 is a rule nobody is following and nobody knows is not being followed, which is worse than a large prompt.
Truncation also fails in the direction that looks fine: everything still works, the agent just quietly ignores the last third of the house style.

What happens instead is that the user is told.
Past `PROJECT_INSTRUCTIONS_WARN_TOKENS = 20_000` estimated tokens, the pane warns and sends the file anyway.
Twenty thousand *tokens*, which is roughly 70,000 characters - not to be confused with the 20,000-*character* cap rejected two paragraphs above, which is about a tenth as much text.

That is around ten times this repository's own `CLAUDE.md` and comfortably above any instructions file written to be read, so it still means something has gone wrong rather than that a file is on the large side.
It is a sixth of a 128k window spent before the conversation starts, and a sixth of every window on every round after that, which the user can act on by shortening the file, splitting it, or moving reference material into a skill where it is fetched only when needed.
Fleet cannot make that call for them, which is exactly why it does not.

`estimateTokens` from `agent-context.ts` does the counting.
It is the same rough 3.5-characters-per-token figure the context meter already uses, and it over-counts, which is the safe direction for a warning.
A tokenizer per model to answer a threshold question would be the wrong trade for the same reason that file already gives.

Injected immediately after the base prompt and before every capability block, because it is the project's own standing rules rather than a Fleet mechanic, and it is unconditional even when the user has overridden the system prompt.
The reasoning is the one `buildSystemPrompt` already applies to the working folder line: a custom prompt is replacing Fleet's instructions, not the project's.

Subagents get it too, for the reason `toolSpecsFor`'s own comment gives for giving them `skill`: a child doing the work needs the house rules as much as the parent, and it has no conversation to have been told them in.

Read fresh every turn. No cache, consistent with everything else on disk.

### 6.7 Where the warning appears

*Author's call, in full. Requirement 5 says the user is warned. It does not say where, and this is the most overturnable decision in the document.*

In the context meter, and nowhere else.

The three places it could go are all worse.
A `log.warn` is invisible to the person who can fix it.
A transcript row is not part of the conversation and would be redrawn or resent every turn, since main reloads the file each time and has no memory of having already said this.
The Settings tab is where you look when you have already decided something is wrong, not where you find out.

The context meter is the right place because the warning and the meter are about the same thing.
`AgentContextMeter` already shows how full the window is and already turns amber past a threshold, and a 20,000-token instructions file *is* context pressure - the most permanent kind, present before the first message and never compacted away.
Putting it there is not overloading amber with a second meaning; it is the same meaning arriving earlier.

Concretely: `loadProjectInstructions` returns `{ text, filename, tokens }`, main puts `{ filename, tokens }` on the existing `AGENT_STREAM_DONE` payload as an optional field, the renderer keeps it on `PaneThread`, and the meter's tooltip gains a line naming the file and what it costs - always, not only when it is large, because "why does this session start at 6k" is a question worth answering at any size.
Past the threshold the meter's amber state is forced on regardless of fill, and the tooltip adds one sentence saying the file is large enough to be worth shortening.

The pure part is one function, `projectInstructionsNotice(tokens, filename)`, returning the tooltip line and whether it is a warning.
It lives in `shared` and is unit-tested, because a threshold that reads the wrong side of its comparison is exactly the bug that goes unnoticed.

### 6.8 What the user sees, and how a bad entry dies

*Locked: visible in the transcript, undoable from Settings (requirement 3), removal is human-only (requirement 6). Author's call: no revision history behind Remove.*

Three independent signals, none of them clever:

1. **At write time**, the write is an ordinary tool row - `Remember <name>` - visible the moment it happens.
2. **Afterwards**, a Memory section in the Agent pane's Settings tab lists every entry in both tiers with its full description, a source badge, Reveal in Finder, and Remove.
   Remove is the undo.
3. **For the project tier, free**, because `.fleet/memory/` is inside the repository and a bad entry turns up in `git status` like anything else the agent touched.

Undo is Remove, not a revision history.
A create is fully undone by deleting the file.
An overwrite's previous content is already in the transcript as a diff, so a person who wants it back can read exactly what changed.
Building a revision store for memory alone, when session logs are append-only and nothing else in this codebase keeps file snapshots, is the speculative infrastructure `CLAUDE.md` rules out.

## 7. Call-site audit

Every line number verified against `ab19fd5e`.
If one does not say what this table claims, re-grep rather than trust it.

| Site | What breaks or is needed | Change |
| :-- | :-- | :-- |
| `agent-tools.ts:54` `SUBAGENT_TOOL_NAMES` | - | Add `'memory'` after `'skill'`. |
| `agent-tools.ts:78` `AGENT_TOOL_NAMES` | - | Add `'memory_write'`, `'skill_write'` to the spread, so subagents do not get them. |
| `agent-tools.ts:476` `AGENT_TOOL_SPECS` | - | Add the static `memory_write` and `skill_write` entries. `memory` is built per turn and does not go here. |
| `agent-tools.ts:854` `toolSpecsFor` | `memory` is built per turn like `skill` | Add `memory?: AgentToolSpec \| null`, filtered by `allowed('memory')` exactly as `skill` is, placed before `skill` in the returned array. |
| `agent-tools.ts:977` `AgentToolContext` | Tools need to find an entry | Add `findMemory: ((name: string) => MemoryDefinition \| null) \| null`, same shape and same `null` meaning as `findSkill`. |
| `tools/run.ts` dispatch switch | New names must route | Three cases, each through the existing `checked(Schema, args, name)` helper. |
| `tools/skill.ts:47` | `skill_write` needs a prior read to satisfy freshness | Add `remember(ctx.threadId, join(definition.dir, 'SKILL.md'), ...)` after rendering. |
| `agent-types.ts:331` `buildSystemPrompt` | Two new blocks | Add `memory?: boolean` and `projectInstructions?: string \| null`. Project instructions go directly after `base`; the memory block goes beside `skill`. |
| `agent-service.ts:846` `turn()` | Loads skills and subagents already | Add `loadMemory(req.cwd)`, `buildMemorySpec(...)`, `loadProjectInstructions(req.cwd)`; pass into `toolSpecsFor` and `buildSystemPrompt`; add `findMemory` to `RoundsRequest`. |
| `agent-service.ts:1171` `runTask()` | A subagent needs the same, minus writes | Same additions, beside its own `loadSkills`. `SUBAGENT_TOOL_NAMES` already excludes the write tools, so no second guard is needed here beyond `findMemory` being provided. |
| `agent-context.ts:207` `REPRODUCIBLE_TOOLS` | Would a memory read be cleared off the wire? | **No change.** `memory` stays out, matching `skill`. What comes back is standing guidance that holds for the rest of the task, not a filesystem probe that is cheap to repeat. |
| `agent-service.ts:654` `toCompactMessages` | Does compaction need to know? | **No change.** It already reduces every tool part to text before summarizing, so these calls compact like any other. |
| `tool-label.ts` | Rows would fall through to the raw tool name | Three cases: `memory` → `Recall`, `memory_write` → `Remember`, `skill_write` → `Write skill`. |
| `agent-types.ts` `AgentStreamDone` | The meter needs to know what the instructions cost | Add an optional `projectInstructions: { filename: string; tokens: number } \| null`. Optional and additive, the shape `resumed` already uses, so an older session replays unchanged. |
| `agent-store.ts` `PaneThread` | Same | One field, set on stream-done, alongside `contextTokens`. |
| `AgentContextMeter.tsx` | The warning has to be somewhere | Take the new field, add the tooltip line, force amber past the threshold. |
| `agent-ipc.ts:73` | Settings needs a list | Register `registerAgentMemoryIpc()` beside the skills one. |
| `AgentSettingsPanel.tsx:230` | - | Mount `<MemorySection />` beside `<SkillsSection />`. |

Two sites deliberately unchanged, recorded so nobody goes looking:

- **`SkillsSection.tsx` and `agent-skills-store.ts` need nothing.**
  A skill written by `/refine` is an ordinary `SKILL.md` in an ordinary tier, and the existing list and Remove already cover anything on disk there regardless of who wrote it.
- **No new IPC channel for `/refine`.**
  It is a command file, so it rides `AGENT_SEND` like any other message.

## 8. Tools

Three new tools. Not five, and not one with a mode argument.

**`memory`** - read one entry. `{ name }`, an `enum` of what exists. Built per turn, `null` when the folder has none.

**`memory_write`** - create or replace one. `{ name, description, body, scope }`, `scope` a required `'project' | 'user'` enum. Always offered. Required rather than defaulted because which tier a fact lands in is consequential and a default would be a guess made by whoever wrote this line rather than by the model that knows what the fact is.

**`skill_write`** - create or replace a skill's `SKILL.md`. Same argument shape. Always offered, with a description that says plainly it is for `/refine` and not for mid-task use.

There is no `memory_delete` and no `skill_delete` (requirement 6), and no `skill` read tool addition because `skill` already exists.

The tool descriptions are the actual design of this feature, and they need writing with the same care as the code.
The load-bearing one is `memory_write`, which has to answer "when is a thing worth writing down" in a way that produces entries like `docs/learnings/` and not like a changelog.
The test it should state is a cost test rather than a taste test: *if this were gone, would the next agent pay roughly what this just cost to learn it again?*
And it needs explicit negatives aimed at the three failure modes, because a model asked to record lessons will otherwise record all three forever:

- not a fact `read` or `grep` returns in one call, because a memory that duplicates a file is wrong the moment the file changes and nobody updates the memory too;
- not a preference the user stated in this conversation, because it is already in the transcript and the next turn can still see it;
- not a record of what was just done, because that is what the transcript is.

The memory-versus-skill line, stated in both `memory_write`'s description and `/refine`'s prompt: **a memory is a fact, a skill is a procedure.**
If what you want to write reads like a checklist, it is a skill.

`/refine`'s prompt has six steps, and the two that matter are the first and the last.
First: read the trajectory as evidence, not as a story - a thing qualifies only if you can point at where it happened, and a `/refine` that writes nothing is a correct and common outcome.
Last: report what you wrote, under which name, in which tier, and the one thing in the session that earned it.
It must also handle the case where the conversation opens on a summary rather than its own first message, and say so rather than citing specifics from a part of the session that has been compacted away.
That is aimed directly at the failure Prime Intellect's own post documents, where an agent under a citation requirement manufactures the citation.

## 9. File manifest

**New**

| Path | What |
| :-- | :-- |
| `src/shared/agent-memory.ts` | Types, frontmatter and arg schemas, caps, `buildMemorySpec`, `renderMemory`, `AGENT_MEMORY_INSTRUCTIONS` |
| `src/shared/agent-project-instructions.ts` | `PROJECT_INSTRUCTIONS_WARN_TOKENS`, pure `renderProjectInstructions` and `projectInstructionsNotice` |
| `src/main/agent/markdown-definitions-write.ts` | `writeFrontmatterFile` |
| `src/main/agent/project-instructions.ts` | `loadProjectInstructions(cwd)` |
| `src/main/agent/memory/definitions.ts` | `loadMemory(cwd)`, `userMemoryDir()` |
| `src/main/agent/memory/write.ts` | `writeMemoryEntry` |
| `src/main/agent/memory/memory-ipc.ts` | list, remove, reveal |
| `src/main/agent/skills/write.ts` | `writeSkillBody` |
| `src/main/agent/tools/memory.ts` | `runMemoryRead` |
| `resources/commands/refine.md` | The command |
| `src/renderer/src/store/agent-memory-store.ts` | Settings store |
| `src/renderer/src/components/agent/settings/memory/MemorySection.tsx` | Settings UI |

**Modified**

`src/shared/agent-tools.ts`, `src/shared/agent-types.ts`, `src/shared/agent-skills.ts` (the `SkillWriteArgs` schema, beside `SkillArgs`), `src/shared/ipc-channels.ts`, `src/main/agent/agent-service.ts`, `src/main/agent/agent-ipc.ts`, `src/main/agent/tools/run.ts`, `src/main/agent/tools/skill.ts`, `src/preload/index.ts`, `src/renderer/src/store/agent-store.ts`, `src/renderer/src/components/agent/AgentContextMeter.tsx`, `src/renderer/src/components/agent/AgentThread.tsx` (passing the new field down to the meter), `src/renderer/src/components/agent/settings/AgentSettingsPanel.tsx`, `src/renderer/src/components/agent/tool-label.ts`.

`electron-builder.yml` needs no change: `resources/commands/` is already copied as an extra resource, which `docs/learnings/2026-08-07-bundled-resource-path-from-the-bundle-not-the-source.md` is the record of getting wrong once.

**Amended during the build.**
Three things in this section turned out to be wrong once the code was written, and the record is here rather than in a commit message.

- **`tools/skill-write.ts` was not created, and `runMemoryWrite` does not exist.**
  Both were wrappers with nothing in them: `run.ts` dispatches to `writeMemoryEntry` and `writeSkillBody` directly, exactly as it already dispatches `runSkill`.
  A file whose whole content is a re-export is a file to read on the way to the one that matters.
- **`AgentSettingsPanel` gained a `cwd` prop**, and `AgentPane.tsx` is a modified file.
  The panel is otherwise app-wide, and `MemorySection` first followed `SkillsSection` in guessing the folder from the recent list.
  That is wrong for memory in a way it is not wrong for skills: the project tier lives inside a repository, so a guess at the wrong folder produces a list that is silently missing entries.
  The panel is drawn inside a pane that knows its own folder, so it is asked.
- **`src/renderer/src/main.tsx` is a modified file**, registering the memory store on the `__FLEET__` dev bridge beside the others, so `fleet-drive` can read it.

## 10. Rendering

Three transcript rows, all ordinary: `Recall <name>`, `Remember <name>`, `Write skill <name>`.
An overwrite carries a diff in its result, the same as `edit` and `write`.
No card, no side-column panel, no pill.
A memory write is a small thing that happened during a turn, and giving it a card would say it was a bigger thing than it is.

The one new piece of drawing in this whole feature is a line in the context meter's tooltip, plus its amber state forced on past the threshold (section 6.7).
No new component: `AgentContextMeter` already has the states and only needs the number.

The Settings section is `SkillsSection.tsx` with the Import and From-a-repository buttons removed and a source badge added.
There is nothing to import: memory is Fleet's own format with no cross-tool ecosystem, and building an importer for a format that does not exist elsewhere is speculative.

## 11. Build sequence

Eleven steps, each verifiable before the next.
Steps 1 to 5 are pure or disk-only with no Electron involved, so everything genuinely easy to get wrong is settled before anything is wired up.

1. `agent-project-instructions.ts` and `project-instructions.ts`. Verify: `AGENTS.md` precedence, neither-present yields `null`, `projectInstructionsNotice` either side of the threshold and exactly on it, and that a file well past the threshold comes back whole rather than shortened.
2. `agent-memory.ts`. Verify: frontmatter validation, caps, `buildMemorySpec` roster and empty-folder `null`.
3. `markdown-definitions-write.ts`. Verify: round trip, a description containing `": "` survives, a schema-invalid write throws before touching disk, a failed `rename` leaves the original intact.
4. `memory/definitions.ts`. Verify: precedence, bad frontmatter skipped, name-versus-filename mismatch skipped and logged.
5. `memory/write.ts` and `skills/write.ts`. Verify: create needs no read, overwrite without a read throws, overwrite after a read produces a diff.
6. `agent-tools.ts` wiring and `tools/run.ts` dispatch, plus `tools/memory.ts` and `tools/skill-write.ts`. Verify: `npm run typecheck` - the closed union finds every `AgentToolContext` literal that is now incomplete, which is roughly seven test fixtures plus `agent-service.ts`.
7. `buildSystemPrompt` options. Verify: existing prompt tests extended for ordering and for the override case.
8. `agent-service.ts` `turn()` and `runTask()`, plus the new `AGENT_STREAM_DONE` field. Verify: a subagent's tool list has no `memory_write`; both get project instructions; a 200,000-character `AGENTS.md` reaches the built prompt in full.
9. `resources/commands/refine.md`. Verify: `expandCommand('/refine', cwd)` returns the body.
10. IPC, preload, store, `MemorySection`, `AgentSettingsPanel`, `tool-label.ts`, `AgentContextMeter`. Verify: typecheck, then `fleet-drive` screenshots at a wide and a narrow width, including a folder with an oversized `AGENTS.md` so the amber state and the tooltip are seen rather than assumed.
11. Full pass: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## 12. Test plan

**Pure, in `src/shared/__tests__/`.** Frontmatter validation and caps; `buildMemorySpec` roster shape and the empty case; `projectInstructionsNotice` on both sides of the threshold and on it exactly; `renderMemory`'s framing header.

**The one test that matters most for `AGENTS.md`.** A file of 200,000 characters goes into the built system prompt in full, byte for byte, and the notice says it is large.
Written as an assertion about the prompt rather than about the loader, because the regression to fear is somebody later adding a `.slice()` somewhere between reading the file and building the prompt, with the best of intentions.

**Disk-backed, temp dirs, in the style of `skills/__tests__/definitions.test.ts`.** Two-tier precedence; a file whose `name` disagrees with its filename; write round trip including the `": "` case from the learnings file; create-versus-overwrite freshness; atomicity under a mocked `rename` failure.

**`agent-service.test.ts` additions.** A turn's tool list contains `memory_write`; a subagent's does not; a subagent's `findMemory` is provided; the system prompt contains the project-instructions block when the file exists and not when it does not, including under a `systemPrompt` override.

**Manual, with `fleet-drive`.** Write a memory in one session, confirm the row reads `Remember`, confirm the file appears, confirm it is in the next session's roster, confirm Settings lists it and Remove deletes it and it leaves the roster.
Then run `/refine` on a session containing a real correction and confirm what it writes is worth having, which is the only test that actually judges this feature.

## 13. Baseline to hold

Measured on `ab19fd5e` before any of this.

- **Tests: 2,261 passing across 183 files, all green.** Keep it green.
- **Typecheck: clean.**
- **Lint: 287 problems, 104 errors, 183 warnings.** Pre-existing, and nothing in CI runs eslint. Do not add to it and do not fix it here.

## 14. Known risks

What is deliberately not being built is in section 1, under Non-goals.
What follows is the part that *is* being built and could still go wrong.

**The skill-write boundary is wording, and wording is not a boundary.**
Requirement 4 chose the command file over a builtin turn, and the cost is that `skill_write` is offered on every turn with only its own description telling the model not to use it outside `/refine`.
A model that ignores that sentence rewrites a skill mid-task, and a skill is loaded as instructions on every later turn that matches it, so the blast radius is larger than a memory file nobody has to read.
The freshness guard limits it - an existing skill cannot be replaced without being read first in the same conversation - but a *new* skill can be created freely by any turn.
If this turns out to happen in practice, the fix is the clean proposal's shape, and section 5 records it in enough detail to build.

**The roster is unconditional and the agent controls its length.**
Every entry's description rides on every round of every turn, whether or not anything today is about it.
At 200 characters and a hundred entries that is roughly 20,000 characters, near 5,700 estimated tokens, added to every request for as long as the pane is open.
The description cap bounds it per entry and the Settings list is how a person trims it, but nothing bounds the total, and the decision not to cap the count (section 5) is a bet that a cliff would be worse than a slope.
This is the number to watch first if the feature goes wrong quietly.

**Nothing bounds the system prompt any more, and that is on purpose.**
Requirement 5 removed the cap on `AGENTS.md`, so a repository with a 300,000-token instructions file will send it, warn, and get a context-length error from the provider on the first turn.
That is the intended behaviour: the failure is loud, attributable to a file the user controls, and fixable by them, where a silent truncation would have been none of those things.
It does mean Fleet no longer has any ceiling on what a folder can put in front of the model, and a pane opened on a hostile repository is limited only by the provider's own error.
The warning threshold is not a defence against that and is not meant as one; it is a message to somebody who wants their agent to work well.

**A memory can be true when written and false a month later.**
Nothing re-checks entries against the code they describe.
`/refine`'s prompt requires verifying a file or command with `read` or `grep` before citing it, which stops an entry being born stale, and that is all that is being done here.
Automated staleness detection is a subsystem of its own and is deliberately out of scope.

**A project-tier memory ships inside a repository.**
So does `AGENTS.md`.
Both are read into the system prompt or into a tool result on a folder the user may only have cloned to look at, which is a prompt-injection surface this design names and does not close.
`renderMemory` and `renderProjectInstructions` both carry the framing header `renderSkill` already uses - authoritative about their own subject, never a reason to do something the user has said not to - which is mitigation rather than a fix.

**Quality is not enforceable and the bar is lower than `docs/learnings/`.**
Those files are written by a person who understood the bug: a named symptom, one general actionable sentence, and how it was found.
An agent writing mid-turn from inside the situation will mostly not reach that.
The design's answer is the cost test in `memory_write`'s description, the three explicit negatives, and the Settings list that makes a bad entry visible - and none of that guarantees anything.
This should be judged after a fortnight of real use by reading `.fleet/memory/` and asking whether any of it earned its place, not by a test.
