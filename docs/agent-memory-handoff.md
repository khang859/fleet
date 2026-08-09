# Handoff: implement Agent pane memory and `/refine`

You are picking up a feature that has been researched, specified and designed, and not written.
This document is the working brief.
The design itself is in **`docs/agent-memory-plan.md`** and you must read it before writing anything.

Read the plan in full first.
It is about 500 lines: section 1 bounds the work, section 6 is the architecture you are building, section 7 is the call-site audit that will otherwise cost you an afternoon, section 11 is your build order, and section 12 is your test list.
This document does not repeat that content.
It tells you the state of the tree, what has already been decided and must not be reopened, the exact anchors you will edit, the traps specific to this repo, and what done means.

## 1. State of the tree

Branch `main` at `ab19fd5e`, clean except for the two design docs.
**No source file has been touched.**
There is no partial implementation to find, no stub to fill in, no branch to check out.

Baseline, measured on `ab19fd5e`:

- **Tests: 2,261 passing across 183 files, all green.** Keep it green.
- **Typecheck: clean.**
- **Lint: 287 problems, 104 errors, 183 warnings.** Pre-existing, and nothing in CI runs eslint. Do not add to it and do not fix it here (see section 7).

## 2. What is already decided

Seven requirements, settled with the user across two rounds of questions and recorded as section 3 of the plan.
**Do not reopen any of them.**
If you believe one is wrong, say so and stop, rather than quietly building something else.

1. Memory entries are flat markdown with YAML frontmatter, two tiers - project `<cwd>/.fleet/memory/` and user `~/.fleet/memory/` - most specific winning a repeated name. No bundled tier.
2. Progressive disclosure, skill-style: names and one-line descriptions ride in the `memory` tool's own description every round, bodies arrive only on a call.
3. The agent writes memory **silently mid-turn**. No permission card. An ordinary tool row in the transcript, and a list in Settings where the user sees and removes.
4. `/refine` is a **bundled markdown command file**, not a builtin turn. Its edit surface is memory entries and skills.
5. `AGENTS.md`, falling back to `CLAUDE.md`, injected unconditionally and **never truncated**. Past 20,000 estimated tokens the user is warned and the whole file is still sent.
6. **No delete tool**, for memory or skills. Overwrite by name is how a wrong entry is corrected. Removal is a human action in Settings.
7. **Subagents read memory and do not write it.**

The architecture is section 6 of the plan, reconciled from three independent proposals.
Where they disagreed, section 5 records which won and why, including one proposal rejected outright for gating a capability by sniffing whether `req.text` looks like `/refine`.
You do not need to rediscover any of that.

**Section 6 is tagged, and the tags matter to you.**
Each subsection says whether it is *locked* by a requirement above or an *author's call* made while designing.
The author's calls are genuinely open: if one looks wrong once you are inside the code, say so before you build around it.
The locked ones are not.

## 3. Build order

Follow section 11 of the plan.
Eleven steps, each verifiable before the next begins.

The ordering is not arbitrary.
Steps 1 to 5 are pure or disk-only with no Electron involved, so the YAML round trip, the two-tier precedence walk and the freshness rule - everything genuinely easy to get subtly wrong - are all settled before anything is wired up.
Step 6 is where the closed `AgentToolContext` shape propagates through roughly seven test fixtures at once, and you want that to be the only thing failing when it happens.
Do not collapse steps to save time; the point is that when something breaks you know which step broke it.

## 4. Anchors

Every line number below was verified against `ab19fd5e` on a clean tree.
If one does not say what this table claims, the tree has moved and you should re-grep rather than trust the number.

### Precedents to copy from

| What you need | Where it already exists |
| :-- | :-- |
| The three-tier on-disk definition walk | `src/main/agent/markdown-definitions.ts:70` `loadDefinitions`, used unchanged |
| A roster in a tool description, body fetched on call | `src/shared/agent-skills.ts:191` `buildSkillSpec`, mirrored closely |
| A framing header wrapped around text from a file | `src/shared/agent-skills.ts:246` `renderSkill`, mirrored |
| Refusing to overwrite a file the model has not read | `src/main/agent/tools/freshness.ts`, `remember`/`requireFresh`, keyed by `(threadId, absPath)` |
| Showing what a write changed | `src/main/agent/tools/edit.ts:65` `diffReport` |
| Confinement against a root that is not `cwd` | `src/main/agent/tools/paths.ts:76` `resolveInsideCwd(target, root)`, already called by `tools/skill.ts:76` with a skill's own folder |
| Atomic durable write | `schedule-store.ts:343`, temp file then `renameSync` |
| A slash command that is only a file | `src/main/agent/commands/expand.ts:22` `expandCommand`, plus `resources/commands/*.md` |
| A settings list of file-backed things with Reveal and Remove | `settings/skills/SkillsSection.tsx` with `store/agent-skills-store.ts` |
| Per-turn on-disk loads at the top of a turn | `agent-service.ts:846`, which already loads skills and subagents |
| A generic tool row needing no bespoke component | `AgentToolRow.tsx`, driven by `tool-label.ts` |

### Sites you will edit

The full table is section 7 of the plan, with the reason for each.
These are the ones where the change is easy to get subtly wrong:

| Site | Line | What goes there |
| :-- | --: | :-- |
| `src/shared/agent-tools.ts` | 54 | `'memory'` into `SUBAGENT_TOOL_NAMES`, after `'skill'` |
| `src/shared/agent-tools.ts` | 78 | `'memory_write'` and `'skill_write'` into the **spread**, not the base list |
| `src/shared/agent-tools.ts` | 476 | Static `memory_write` and `skill_write` specs. `memory` is built per turn and does not go here |
| `src/shared/agent-tools.ts` | 854 | `toolSpecsFor` takes `memory?: AgentToolSpec \| null`, filtered by `allowed('memory')` exactly as `skill` is |
| `src/shared/agent-tools.ts` | 977 | `findMemory` on `AgentToolContext`, same shape and same `null` meaning as `findSkill` |
| `src/shared/agent-types.ts` | 331 | `buildSystemPrompt` gains `memory?: boolean` and `projectInstructions?: string \| null` |
| `src/main/agent/agent-service.ts` | 846 | `turn()`: load memory and project instructions beside the existing skill load |
| `src/main/agent/agent-service.ts` | 1171 | `runTask()`: the same, minus the write tools |
| `src/main/agent/tools/skill.ts` | 47 | `remember(...)` after rendering, so `skill_write` can satisfy freshness |
| `src/shared/agent-context.ts` | 207 | **No change.** `memory` stays out of `REPRODUCIBLE_TOOLS`, matching `skill`. Recorded so you do not go looking |

Two sites deliberately unchanged and recorded in the plan so nobody hunts for them: `SkillsSection.tsx` needs nothing, because a skill written by `/refine` is an ordinary `SKILL.md` in an ordinary tier; and `/refine` needs no IPC channel, because a command file rides `AGENT_SEND` like any other message.

The full file manifest, including thirteen new files, is section 9 of the plan.

## 5. Traps

These are the specific ways this task goes wrong.

**A description containing `": "` breaks YAML and fails silently.**
This has already happened once and is written up in `docs/learnings/2026-04-28-pi-skill-frontmatter-yaml.md`.
It is the reason `writeFrontmatterFile` parses its own output back through the *reader's* schema before touching disk.
A memory the writer cannot read back does not fail loudly - it is skipped by the loader with a `log.warn` nobody sees, and the agent goes on believing it wrote something.
Never hand-build the frontmatter with a template literal, however obvious it looks.

**One line decides requirement 7, and getting it backwards fails silently.**
`AGENT_TOOL_NAMES` at `agent-tools.ts:78` is `SUBAGENT_TOOL_NAMES` plus a spread.
Adding a write tool to the base list hands subagents the ability to write memory, which is the thing requirement 7 exists to prevent, and nothing at all will fail: no type error, no test, no visible misbehaviour until a subagent writes something with no provenance.
The test asserting a subagent's tool list has no `memory_write` is not optional decoration.

**Do not put a `.slice()` anywhere between reading `AGENTS.md` and building the prompt.**
Requirement 5 is that the file is never truncated, and every instinct you have will be to bound it.
The plan argues this out at length in section 6.6; the short version is that a truncated instruction file fails in the direction that looks fine.
Section 12 has a test asserting a 200,000-character file reaches the *built prompt* in full, written against the prompt rather than the loader precisely because the regression to fear is a well-intentioned cap added later somewhere in the middle.

**`memory` returns `null` on an empty folder; `memory_write` does not.**
Copying `buildSkillSpec` wholesale gets this wrong in the direction that makes the feature inert, because memory has to be writable into existence.
Section 6.3 is one paragraph and exists solely for this.

**`resolveInsideCwd`'s first parameter is named `cwd` but it is a root.**
`tools/skill.ts:76` already passes a skill's own folder. User-tier memory and user-tier skills live outside the working folder, and this is how they are confined without weakening anything.

**`runMemoryRead` must call `remember`.**
Freshness is keyed by `(threadId, absPath)`, so without it the obvious sequence - read an entry, notice it is wrong, correct it - costs two reads and looks like a bug in the tool.

**`resources/commands/refine.md` must be resolved from the bundle, not the source tree.**
`docs/learnings/2026-08-07-bundled-resource-path-from-the-bundle-not-the-source.md` is the record of getting this wrong once.
`electron-builder.yml` itself needs no change: `resources/commands/` is already copied.

**Run `npm test`, never `npx vitest run`.**
After `npm run dev` the sqlite addon is built for Electron's ABI, and calling vitest directly produces roughly 456 phantom failures that have nothing to do with your change.

**Check whether a dev server is already running before starting one.**
A second `npm run dev` breaks `fleet-drive`.

**The renderer store test suite has tripped on `vi.mock`-versus-`require` ordering before.**
If mocks appear not to apply, suspect that before your own logic.

## 6. Conventions that will be enforced in review

- **Never the em dash.** Plain dash only, in code comments and prose alike.
- **No `as` type assertions and no `eslint-disable` anywhere in `src/`.** Runtime validation is zod. The existing violations are not a licence to add one.
- **Comments here explain why, at length, in prose,** and are a large fraction of every file. Read `src/main/agent/tools/task.ts` and the header of `src/shared/agent-tools.ts` to calibrate. This feature has a lot of non-obvious reasoning behind it that belongs beside the code rather than only in a plan document.
- **Tests are vitest, colocated in `__tests__/`.** The dominant style pulls pure logic out of `.tsx` into a plain `.ts` sibling so it can be unit-tested without a renderer, which is why `projectInstructionsNotice` is a pure function in `shared` rather than a branch inside `AgentContextMeter`.
- **Simplicity first.** Minimum code that solves the problem, no speculative abstraction. Section 1 of the plan lists the non-goals; do not build them.
- **Surgical changes.** Touch only what the feature needs. If you notice unrelated dead code, mention it rather than deleting it.
- **In long Markdown files, one full sentence per line.**
- **Never add an agent name as a commit co-author.** Never hand-edit `CHANGELOG.md`.

**The tool descriptions are the deliverable, not documentation of it.**
Section 8 of the plan is mostly about them, and `memory_write`'s is load-bearing: it has to answer "when is a thing worth writing down" with a cost test rather than a taste test, and carry three explicit negatives, or the agent will record duplicated file contents, restated user preferences and diary entries forever.
Zod validates shape, not whether an entry earned its place.
Nothing else in this design defends against a folder full of noise.

## 7. Out of scope

**Do not fix these here, even though you will see them.**
Both are filed and both remain open.

- **[#515](https://github.com/khang859/fleet/issues/515)** - `shiki` is held at a working version only by the lockfile, so any dependency refresh breaks the web typecheck. If your tree fails typecheck at `AgentMarkdown.tsx` complaining about `"actionscript"`, this is why and you did not cause it.
- **[#516](https://github.com/khang859/fleet/issues/516)** - nothing in CI runs eslint, and one of the 104 errors is a real conditional-hooks bug in `CopilotSection.tsx`.

The general project rule is to fix lint and test problems you encounter even when unrelated.
These two are the deliberate exception, because they are filed and separately sized.

Everything under **Non-goals in section 1 of the plan** is also out of scope, and that list is the boundary of this task: no similarity search, no staleness detection, no revision history, no recursive `AGENTS.md` discovery, no importing another tool's memory format, no automatic `/refine`.

## 8. Done means

1. `npm run typecheck` clean.
2. `npm test` green, with all of section 12's cases present.
3. `npm run lint` has not grown past the 287-problem baseline.
4. Every row of section 7's call-site audit accounted for, including the two marked no-change-needed.
5. **The subagent boundary proved by test, not by reading the diff.** A pane turn's tool list contains `memory_write`; a subagent's does not; a subagent's `findMemory` is still provided.
6. **`AGENTS.md` proved whole.** A 200,000-character file reaches the built system prompt byte for byte, and the notice says it is large.
7. **Verified end to end in the running app, by you, with `fleet-drive`.** Write a memory in one session and watch the row read `Remember`; confirm the file on disk; confirm it is in the next session's roster; confirm Settings lists it, Remove deletes it, and it leaves the roster. Screenshot the context meter at a wide and a narrow width against a folder with an oversized `AGENTS.md`, so the amber state and the tooltip are seen rather than assumed. Be picky about the pixels.
8. **`/refine` run once on a real session** containing a real correction, and the entry it wrote judged by reading it. This is the only test that judges the feature rather than the code, and if what it writes is not worth keeping, the tool descriptions are wrong and the fix is there rather than in the plumbing.

If you finish and something in the plan turned out to be wrong, amend `docs/agent-memory-plan.md` rather than leaving the two out of step.
Section 14 already names the parts the design flags as weakest.
The skill-write boundary is the one to watch: it is wording rather than a type, and section 14 says what to do if a model turns out to ignore it.
