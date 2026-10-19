# Claude Code and eva flags for crew panes

Crew panes run the interactive Claude Code TUI and the eva TUI with flags only.
Each flag and settings key was checked against the docs and the changelog on 2026-10-17, with Claude Code 2.1.302 and eva 0.3.0 installed.

## Claude Code: oldest version per flag

The changelog lists the newest release first, so the oldest version is the last mention, not the first.
A first script read the first mention and gave versions that were far too new.

| Flag or key                                | Oldest version                                           |
| ------------------------------------------ | -------------------------------------------------------- |
| `--add-dir`                                | 1.0.18                                                   |
| `--append-system-prompt` (interactive)     | 1.0.51                                                   |
| `UserPromptSubmit` hook                    | 1.0.54                                                   |
| `--settings`                               | 1.0.61                                                   |
| `disableAllHooks`                          | 1.0.68                                                   |
| `PermissionRequest` hook                   | 2.0.45                                                   |
| `--session-id`                             | older than 2.0.73, which added fork support to it        |
| `permissions.disableBypassPermissionsMode` | 2.1.69 or older                                          |
| `StopFailure` hook                         | 2.1.78                                                   |
| `--permission-mode`                        | older than every mention; the oldest is a fix in 2.1.132 |

Crew need 2.1.78, for `StopFailure`.
`RUNTIME_MIN_VERSION` in `src/shared/agency-crew.ts` holds it.

## Claude Code behavior that shaped the code

- `--add-dir <directories...>` takes several values, so it must not sit right before the prompt. The launch puts it first, and `--` ends the options before the prompt, so a brief that starts with a dash stays the prompt.
- `--settings` ranks above user and project settings, and below managed settings. List keys such as `permissions.deny` merge across files.
- `disableBypassPermissionsMode` is a lock: the strictest value of any file wins. With it in the job file and `--permission-mode default`, crew cannot run in bypass mode, whatever the user's `defaultMode` is. A bypass `defaultMode` is only a warning.
- `editorMode` is a plain key, so `"normal"` in the job file wins over a user's `"vim"`. Only managed settings can still turn vim on, which is a warning.
- `disableAllHooks` in user, project or local settings turns off Fleet's hooks too. The check refuses Claude crew then, rather than override the user's choice from the job file.
- Claude Code runs one identical hook command once, so the job file repeats the global entries word for word (`fleetHookEntries`).
- `StopFailure` input has `error` (`rate_limit`, `overloaded`, `authentication_failed`, `billing_error`, ...), optional `error_details`, and `last_assistant_message`, which holds the API error text. Its output is ignored. The Go hook reports it as status `api_error`.

## Auto mode (job j28, Claude Code 2.1.304)

- `--permission-mode auto` works with Fleet's crew launch shape, checked on Claude Code 2.1.304.
- `disableAutoMode` (top level or under `permissions`) set to `"disable"` in any settings file starts the session in Manual mode with no error. The settings schema text says otherwise; it is wrong. Fleet only warns (`Auto mode available`).
- Claude Code reads `autoMode` from the `--settings` file, and `"$defaults"` as the first `hard_deny` entry keeps the built-in rules.
- A call the classifier blocks fires `PermissionDenied`, not `PermissionRequest`, so it never reaches the Admiral.
- `hard_deny` is a strong net, not a lock: one j28 run let a `/private/tmp` write pass. `permissions.deny` is the lock, so pushes and pull requests are denied there too.

## Folder trust

The docs say how Claude Code keys the trust it stores:

- In a repository, on the main checkout's root, also for a worktree. So trusting the repository once covers every crew worktree of it.
- Outside a repository, on the folder it started in, covering its subfolders except nested repositories. A folder project's job workspaces are plain folders in `~/.fleet/agency/jobs/`, so trusting that folder covers them.

Checked end to end on 2026-10-17: the crew command line from `crewLaunch`, run in a Fleet pane in a new detached worktree of this repository, started with no trust prompt.
In the same run, the session id was the one Fleet picked, `--model haiku` took effect, a brief and a role that start with `- ` arrived whole, the hooks reported the session to Fleet, and the model said it had no AskUserQuestion tool.

Fleet must never read `~/.claude.json`, where the trust is stored.
It knows a folder is trusted when a Claude Code session reports from it or from a folder in it, since no hook runs before the trust prompt is answered (`claude_trust` in `agency.db`).
Two cases can make that wrong: a `claude -p` run, which skips the prompt, and a session in a nested repository of an umbrella.
Then a crew member waits at the trust prompt, which the `needs-you` crew state covers.

## eva

eva 0.3.0 added every flag crew use: `--session-id`, `--name`, `--goal`, `--instructions` and `--no-ask-user`.
eva has no `--model` flag; `CHAT_MODEL` in the environment takes the place of the saved model.
eva also ends options with `--`.
Fleet passes `-b` only when the client turns on eva bypass in Settings (see `eva-crew-is-not-claude.md`).
Fleet never reads `~/.eva/config.toml` itself, which holds the key: the shell reads it, and prints only the lines Fleet needs.
