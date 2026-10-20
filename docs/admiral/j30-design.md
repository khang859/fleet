# j30 design: crew permission modes

Step `design` of job j30.
Builds on j28's report (`auto-mode-report.md`), which verified Claude Code auto mode with Fleet's launch shape on Claude Code 2.1.304.

## Problem

Crew raise a permission request for almost every command.
Each one costs an Admiral turn, and often a client card.
The client wants routine work to run without requests.

Claude Code has an auto mode with a classifier.
eva has only an all-or-nothing bypass.
Both new settings must ship off, so nothing changes until the client turns them on.

## Decisions

### 1. Setting keys

| Key                                 | Values                    | Default     | Change rule                                           |
| ----------------------------------- | ------------------------- | ----------- | ----------------------------------------------------- |
| `agency.crew.claude.permissionMode` | `'default'` \| `'auto'`   | `'default'` | to `'default'`: `apply`; to `'auto'`: `client-only`   |
| `agency.crew.eva.permissionMode`    | `'default'` \| `'bypass'` | `'default'` | to `'default'`: `apply`; to `'bypass'`: `client-only` |

The Admiral can turn either mode off at once, but never on.
Turning a mode on removes the Admiral's own check on crew calls, so only the client does it, in Settings > Agency > Crew.
This is stricter than j28's `approve` suggestion: with `approve`, an injected instruction could still put an "on" card in front of the client.

The field is one shared type, so `Record<CrewRuntime, CrewRuntimeSettings>` stays as it is.
Each key's zod schema allows only its own runtime's values.

### 2. Settings type, read and write

`src/shared/agency.ts`:

```ts
/** How crew of a runtime are asked about tool calls. `auto` is Claude Code's, `bypass` is eva's. */
export type CrewPermissionMode = 'default' | 'auto' | 'bypass';

export type CrewRuntimeSettings = {
  atOnce: number | null;
  defaultModel: string;
  /** `default` asks the Admiral, as crew always did. */
  permissionMode: CrewPermissionMode;
};
```

`DEFAULT_AGENCY_SETTINGS.crew`: both runtimes get `permissionMode: 'default'`.
`mergeCrew` in `src/main/settings-store.ts` already fills a missing field from the defaults, so a saved file from before this change reads as `'default'`.

`src/shared/agency-settings.ts`:

- Add `'agency.crew.claude.permissionMode'` (label `Claude crew permission mode`, schema `z.enum(['default', 'auto'])`) and `'agency.crew.eva.permissionMode'` (label `eva crew bypass mode`, schema `z.enum(['default', 'bypass'])`), after the `defaultModel` keys.
- Add one rule object, `onIsClientOnly`: `kind` returns `'apply'` when `after === 'default'`, else `'client-only'`; `rule` is `"turning it off applies at once; only the client turns it on, in Settings > Agency > Crew"`.

`src/main/agency/settings/index.ts`:

- `readAgency`: two `case`s returning `settings.crew.<runtime>.permissionMode`.
- `writeAgency`: one combined `case` for both keys, like `defaultModel`, calling `writeCrew(settings, runtime, { permissionMode: value === 'auto' || value === 'bypass' ? value : 'default' })`.

### 3. How the mode reaches the launch

The mode is read from settings at every hire, resume and test, next to `defaultModel`.
A resumed member takes the current setting.

| Where                                             | Change                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crew-service.ts` `CrewServiceDeps`               | Add `permissionMode?: (runtime: CrewRuntime) => CrewPermissionMode`. In `start()`, pass `permissionMode: this.deps.permissionMode?.(runtime) ?? 'default'` into `crewLaunch`. |
| `src/main/agency/index.ts:414`                    | Wire `permissionMode: (runtime) => agencySettings.get().crew[runtime].permissionMode`.                                                                                        |
| `src/main/agency/index.ts:1259` `testCrewRuntime` | Read the mode the same way and pass it to `testRuntime`.                                                                                                                      |
| `runtime-test.ts` `testRuntime`                   | Add a `permissionMode: CrewPermissionMode` parameter after `model`, and pass it into `testLaunch`.                                                                            |
| `runtimes.ts` `CrewHire`, `TestStart`             | Add `permissionMode: CrewPermissionMode` (required).                                                                                                                          |

`runtimes.ts`, Claude (`claudeLaunch` and `testLaunch`):

- `const auto = hire.permissionMode === 'auto'`.
- Pass `'--permission-mode', auto ? 'auto' : 'default'` in place of the fixed `'default'`.
- Pass `claudeJobSettings(hooks, { hookCommand, auto })` (see 4).
- Any other stored value, `'bypass'` included, gives `default`.

`runtimes.ts`, eva (`evaLaunch` and the eva branch of `testLaunch`):

- When `permissionMode === 'bypass'`, add `-b` and `--permissions "$FLEET_CREW_PERMISSIONS"`, after the hooks args.
- New env name `ENV.permissions = 'FLEET_CREW_PERMISSIONS'`, the path `join(dir, 'eva-permissions.toml')`.
- Write that file on every launch, resume included, as the hooks file is.
- Any other value gives today's command, byte for byte, and no file.
- Never pass `--permissions` without `-b`. The file replaces the user's `allow` rules (eva `src/permissions.rs`, `load`), so in default mode it would drop them and add requests.
- Update the `evaLaunch` doc comment ("Never `-b`...") to say `-b` comes only from the setting.

Verified against eva 0.6.0 (`eva --help` and the v0.6.0 tag of its source): the flag is `-b, --bypass`, and `--permissions file` takes a `[permissions]` table with `allow`, `ask`, `deny` and `lock_bypass`.

### 4. Claude guardrails in the job settings file

`src/main/agency/crew/job-settings.ts`:

```ts
export function claudeJobSettings(
  hooks: Record<string, HookEntry[]>,
  opts: { hookCommand?: string; auto?: boolean } = {}
): Record<string, unknown>;
```

With `auto` unset or false, the output is exactly today's.
With `auto: true`:

- `permissions.deny` becomes `['AskUserQuestion', ...CREW_HARD_DENY]`.
- `permissions.disableBypassPermissionsMode: 'disable'` stays as it is.
- A top-level `autoMode` block is added:

```json
"autoMode": {
  "hard_deny": [
    "$defaults",
    "Fleet crew boundary: never push any git branch or tag, and never open, approve, merge or close a pull request. Fleet does these itself after the step.",
    "Fleet crew boundary: never create, write, change or delete any file outside the session's working directory and its --add-dir folders, by any tool or shell command.",
    "Fleet crew boundary: never deploy to production, and never change cloud resources, DNS, secrets or IAM."
  ]
}
```

One shared constant in the same file:

```ts
/** Commands crew never run in auto or bypass mode: Fleet pushes and opens pull requests itself. */
const CREW_DENY = ['git push*', 'gh pr create*', 'gh pr merge*', 'gh pr review*'];
```

Claude takes them as `Bash(<rule>)`, eva as `bash(<rule>)`.

Why both `deny` and `hard_deny`:

- `permissions.deny` is the only hard lock, and holds in every mode. It matches only commands as written.
- `hard_deny` is applied by the classifier with judgment (j28 run 6). It catches indirect forms and covers what no pattern can, such as writes outside the worktree.

This differs from j28, which paired `hard_deny` with `ask` rules.
Crew never need to push, so a request to the Admiral for it is a wasted turn.
`deny` stops it with no turn.

j28 verified that Claude Code reads `autoMode` from the `--settings` file and that `"$defaults"` keeps the built-in rules.

### 5. eva guardrails

**Yes, eva honours a guardrail block, but only pattern rules.**
From eva 0.6.0's `docs/tools.md#permissions` and `src/permissions.rs`:

- A `deny` rule holds "even in bypass mode or with stdin or stdout piped". The model is told the rule, and no hooks run.
- `ask` and `deny` rules from every file combine, so the user's own rules and any project `.eva/settings.toml` still apply.
- A `bash` command is split into the commands it chains or nests, and any one denied denies the whole call.
- There is no classifier, no judgment and no fallback to asking after blocks.

`job-settings.ts` gets:

```ts
/** The `--permissions` file of an eva crew member in bypass mode. */
export function evaJobPermissions(): string;
```

It returns:

```toml
[permissions]
deny = ["bash(git push*)", "bash(gh pr create*)", "bash(gh pr merge*)", "bash(gh pr review*)"]
```

That is `CREW_DENY` as `bash(...)` rules, and nothing else.
Build it with `stringify` from `smol-toml` (already a dependency), so no quoting is done by hand.
No `allow` (bypass makes it moot) and no `ask` (whether an `ask` match fires eva's `PermissionRequest` hook under bypass is not verified; `deny` needs no answer).
`--no-ask-user` already removes eva's question tool, so no rule is needed for it.

**What eva bypass does not hold, stated plainly:**

- Writes outside the worktree. eva path rules match a path relative to the working folder and in full, so no rule can say "outside the worktree", and `bash` cannot be limited by path.
- Deploys and cloud changes. No command pattern list covers them.
- Every other call runs unasked. eva's `PermissionRequest` hook never fires, so no eva crew request reaches the Admiral, and nothing is logged in the job.

So eva bypass trades all oversight but the push and PR rules for speed.
The Settings note for it must say so (see 7).
A later step can close the write gap in Fleet's own hook: under bypass eva still runs `PreToolUse` hooks, and a hook `deny` stops the call, so the Go hook could deny `write_file` and `edit_file` outside the worktree with an exact path check.
That is out of scope here.

### 6. Fallbacks

**Claude, `disableAutoMode`.**
If any settings file sets `disableAutoMode` or `permissions.disableAutoMode` to `"disable"`, Claude Code starts in Manual with no error (j28 run 2).
That is today's behaviour, so Fleet does nothing at launch.
An older Claude Code, or a model with no auto mode, also starts in Manual.
`RUNTIME_MIN_VERSION` does not move.

`availability.ts` `claudeSettingsChecks` gets a warning item when the Claude mode is `auto`:
name `Auto mode available`, ok note `Crew run routine work without asking.`, warn note `<path> turns off auto mode, so Claude crew start in Manual mode and ask as before.`
Check both the top-level key and the `permissions` key.
The existing `No bypass mode` warn note changes `Crew start in default mode` to `Crew never start in bypass mode`.
`checkRuntime` takes the mode to do this; its caller reads it from settings.

**eva, `lock_bypass`.**
If any rules file sets `lock_bypass = true`, `eva -b` exits at start with `--bypass cannot be given, as lock_bypass in the permissions keeps changes from being made without asking` (eva `src/main.rs`).
This is not silent: the crew member fails to start, and the hire ends as `NOT_STARTED` like any failed start.
Fleet does not drop `-b` on its own, since the client asked for bypass.
`availability.ts` gets a fail item for eva when the eva mode is `bypass`: name `Bypass allowed`, fail note `lock_bypass in <path> stops eva crew starting in bypass mode. Turn eva bypass off in Settings, or remove the lock.`
It reads `permissions.lock_bypass` from `$EVA_HOME/config.toml` (else `~/.eva/config.toml`) and from `<cwd>/.eva/settings.toml`, with `smol-toml` `parse` as `eva-server.ts` does.

### 7. Settings UI

`src/renderer/src/components/settings/crew/RuntimeDetail.tsx` (beside `RuntimeModels` and `AtOnce`):
one two-option control per runtime, with an `AdmiralChangeNote` for its key, like the model field.

- Claude Code: `Ask the Admiral` / `Auto mode`. Help text: `Auto mode lets a classifier approve routine work. Pushes, pull requests and writes outside the worktree stay blocked.`
- eva: `Ask the Admiral` / `Bypass`. Help text: `Bypass runs every call unasked. Only pushes and pull requests stay blocked; nothing else is checked or logged.`

Match the existing segmented or radio control in that folder; do not add a new component kind.

## Files to change

One builder.
The parts depend on one type and are small, so splitting them would only add merge work.

| File                                                          | Change                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/agency.ts`                                        | `CrewPermissionMode`, the field, the defaults                                                                                                                                                                    |
| `src/shared/agency-settings.ts`                               | Two keys, `onIsClientOnly`                                                                                                                                                                                       |
| `src/main/agency/settings/index.ts`                           | `readAgency`, `writeAgency`                                                                                                                                                                                      |
| `src/main/agency/crew/job-settings.ts`                        | `claudeJobSettings` opts, `autoMode`, `CREW_DENY`, `evaJobPermissions`                                                                                                                                           |
| `src/main/agency/crew/runtimes.ts`                            | `CrewHire`/`TestStart` field, Claude flag, eva `-b` and file                                                                                                                                                     |
| `src/main/agency/crew/runtime-test.ts`                        | `testRuntime` parameter                                                                                                                                                                                          |
| `src/main/agency/crew/crew-service.ts`                        | `permissionMode` dep, pass into `crewLaunch`                                                                                                                                                                     |
| `src/main/agency/index.ts`                                    | Wire the dep (~414), the test (~1259), and `checkRuntime`'s mode                                                                                                                                                 |
| `src/main/agency/crew/availability.ts`                        | Two new items, one note fixed                                                                                                                                                                                    |
| `src/renderer/src/components/settings/crew/RuntimeDetail.tsx` | The two controls                                                                                                                                                                                                 |
| `docs/learnings/claude-code-crew-flags.md`                    | j28's facts: auto verified on 2.1.304, `disableAutoMode` starts Manual silently (the schema text is wrong), `autoMode` read from `--settings`, classifier blocks fire `PermissionDenied` not `PermissionRequest` |
| `docs/learnings/eva-crew-is-not-claude.md`                    | eva `deny` holds under bypass; `--permissions` replaces `allow`; `-b` with `lock_bypass` exits                                                                                                                   |
| `openspec/changes/add-admiral-agency/design.md`               | Update decision 7 (`--permission-mode`) and decision 8 (who judges a call in auto and bypass mode), if that change folder still exists                                                                           |

Test fixtures that build `CrewRuntimeSettings` or `CrewHire` by hand get the new field: `src/main/agency/__tests__/fixture.ts`, `agency-plans.test.ts`, `agency-trust.test.ts`, and any other the typecheck names.

## Risks

- The classifier, not the Admiral, judges most Claude calls in auto mode, and those calls leave no job-log record. Accepted by the client by turning it on.
- `hard_deny` is a strong net, not a lock (j28 run 6 let a `/private/tmp` write pass). `deny` is the lock for pushes and PRs.
- eva bypass has no check beyond the push and PR rules (section 5). The UI text says so.
- The client's `rtk` `PreToolUse` hook can `allow` a command before rules and classifier (j28 section 5). It applies today too. Not changed here.
- A bad stored value maps to `default` at launch, so it can never widen a mode.

## Test plan

Existing tests to change:

- `src/main/agency/crew/__tests__/runtimes.test.ts`: hires get `permissionMode: 'default'`; the exact Claude command line (~line 36) and the eva command stay as they are.
- `src/main/agency/crew/__tests__/runtime-test.test.ts:81`: pass the mode; `--permission-mode default` stays for `default`.
- `src/main/__tests__/settings-store.test.ts`: a saved file with no `permissionMode` loads as `'default'` for both runtimes; a patch to one field keeps it.
- `src/main/agency/__tests__/agency-settings.test.ts`: whatever lists every key or reads every value.

New unit tests:

- `runtimes.test.ts`: Claude `auto` gives `--permission-mode auto` and a job file with `autoMode.hard_deny` and the `Bash(...)` denies; Claude `bypass` (bad value) gives `default`; eva `bypass` gives `-b --permissions "$FLEET_CREW_PERMISSIONS"` and writes `eva-permissions.toml`, on resume too; eva `default` gives no `-b`, no `--permissions`, no file; `testLaunch` follows the same rules for both runtimes.
- `job-settings` test (new `__tests__/job-settings.test.ts`): `claudeJobSettings(hooks)` equals today's object exactly; with `auto: true`, `$defaults` is first in `hard_deny` and `disableBypassPermissionsMode` is still `'disable'`; `evaJobPermissions()` parses with `smol-toml` to `{ permissions: { deny: [...] } }` with no `allow` and no `lock_bypass`.
- `agency-settings.test.ts`: both keys parse only their own values (`'bypass'` fails for Claude, `'auto'` fails for eva); `settingKind` is `client-only` for `default` to on and `apply` for on to `default`; `writeAgency` then `readAgency` round-trips.
- `availability` tests: `Auto mode available` warns for each of the two `disableAutoMode` locations only when the mode is `auto`; `Bypass allowed` fails on `lock_bypass = true` in the user or project file only when the eva mode is `bypass`.

Checks: `npm run typecheck`, `npm run lint`, `npm test`.

Manual check with fleet-drive (`npm run drive -- up`): set Claude to Auto mode in Settings > Agency > Crew and press Test; the test pane's status bar shows auto mode on.
Then set eva to Bypass and press Test; the run passes and `eva-permissions.toml` is in the runtime-test folder.
Set both back and confirm the Test command lines match today's.
