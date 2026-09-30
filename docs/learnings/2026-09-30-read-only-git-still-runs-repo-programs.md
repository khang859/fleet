# Read-only git still runs programs the repository names

Found in the Phase 3 code review of the Orchestrator's `fleet_diff`, and reproduced with git 2.53.0 against hostile repositories built in a scratch folder.

## What happened

Fleet's git runner, used by the sidebar's git probe and by `fleet_diff`, ran `status`, `diff HEAD` and `log` with only `-c core.fsmonitor=false`.
Git reads its config from the repository itself, and several reading commands start programs named there:

- A `filter.<name>.clean` or `filter.<name>.process` driver, routed to a path by `.gitattributes`, runs when `diff HEAD` reads a changed file, and when `status` has to hash one to tell whether it changed.
- With `log.showSignature` and `gpg.program` set, `git log` runs that program on a signed commit.
- `status` and `diff` look into submodules, whose own config names its own filters, and a `submodule.<name>.ignore=none` in the outer config beats `-c diff.ignoreSubmodules=all`.

The probe runs on every tracked session's folder, so opening Claude Code in a cloned repository was enough to run its filter.

## How it was fixed

In `src/main/claude-sessions/git-probe.ts`:

- The runner lists the configured drivers with `git config -z --name-only --get-regexp '^filter\.'` and blanks each one's `clean`, `smudge` and `process`, and sets `required=false`.
  The pairs go through `GIT_CONFIG_COUNT` and `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, not `-c`: `-c` splits at the first `=`, and a driver named `a=b` escaped a `-c 'filter.a=b.clean='` blank and still ran.
- `-c log.showSignature=false` joins `core.fsmonitor=false`.
- `status` and `diff` get `--ignore-submodules=all` on the command line, which beats the per-submodule setting.

Listing the drivers and then running git leaves a small window, but changing the config in it needs a process that can already run commands.

## How it was checked

`git-probe.test.ts` builds each hostile repository for real, shows plain git creating a marker file, then shows the runner not creating it.
Each guard was removed in turn and its test failed, including swapping the env pairs back to `-c`.

## Takeaways

- "Read-only git" is not a sandbox: treat a repository's config as untrusted input to any git command Fleet runs on its own.
- When passing config whose key comes from the repository, use the `GIT_CONFIG_KEY_n` env pairs, which carry key and value separately.
- A security test should first prove the attack fires without the fix, or it may pass because the setup never triggered anything (a size change marks a file dirty without hashing it, so no clean filter ran).
