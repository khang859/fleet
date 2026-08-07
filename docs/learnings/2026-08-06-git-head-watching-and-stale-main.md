# Learnings: Showing the git branch in the Agent pane (2026-08-06)

## `fs.watch` on `.git/HEAD` is permanently deaf, not just flaky

**Problem:** The obvious way to notice a branch switch is `fs.watch('<gitdir>/HEAD')`. It never fires. Measured: **0 events across 4 branch switches**, not an occasional miss.

**Cause:** Git does not write `HEAD` in place. It writes `HEAD.lock` and `rename()`s it over `HEAD`, so the inode is replaced on every switch. macOS binds the watcher to the *old* inode, which nothing ever touches again. Verified by watching the inode number change on each switch: `152971770 → 777 → 785 → 792 → 799`. `git switch` and `git checkout` behave identically.

**Fix:** Watch the gitdir **directory** and filter by filename. That caught 8/8 events.

```ts
watch(gitDir, { persistent: false }, (_event, filename) => {
  if (filename === null || !WATCHED.has(filename)) return;
  // debounce ~75ms: one switch produces two events (HEAD.lock, HEAD)
});
```

**Filtering is mandatory, not an optimisation.** Five commits plus a `gc` produced ~75 events in a gitdir, of which only 4 concerned `HEAD`. Without the filter this re-reads on every loose object git writes.

A conflicted merge writes `MERGE_HEAD` *without* touching `HEAD`, so the watched set has to include the operation markers too: `HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_START`, `rebase-merge`, `rebase-apply`.

---

## Read `HEAD`, don't shell out to `git`

**Measured on this machine:** `execFileSync git branch --show-current` ≈ **12.19 ms/op**; resolving the gitdir and reading `HEAD` ≈ **0.047 ms**. About 250x, per pane, per refresh.

Speed is the least of it. Shelling out also brings:

- **The macOS Xcode shim.** `/usr/bin/git` is not git - `codesign` identifies it as `com.apple.dt.xcode_select.tool-shim-public`. Without Command Line Tools installed it pops a **GUI modal** and fails. A background status-line refresh must never be able to do that.
- **PATH.** `launchctl getenv PATH` is empty; a GUI-launched Electron app gets a minimal PATH. Fleet's own `enrichProcessEnv()` fixes this but is fire-and-forget (`void enrichProcessEnv()` in `src/main/index.ts`), so early spawns can still race it.
- **Dubious ownership.** A repo owned by another uid makes `git` exit 128 until `safe.directory` is set. A plain file read has no such gate.

Things that turned out **not** to be problems, all verified: `index.lock` and `HEAD.lock` do **not** block branch reads (`git branch --show-current` succeeds with both held, and on a read-only `.git`); `packed-refs` never affects branch *names* (after `git pack-refs --all`, `HEAD` still says `ref: refs/heads/main`); and git rejects path-traversal branch names (`feature/../../etc/passwd`, leading `-`, spaces, `..` are all refused).

---

## The traps in reading `HEAD` yourself

**Unborn HEAD.** On a fresh `git init` with no commits, `git rev-parse --abbrev-ref HEAD` exits 128 **and prints the literal string `HEAD` to stdout**. Code that reads stdout and ignores the exit code renders a brand-new repo as being on a branch called `HEAD`. The file has said `ref: refs/heads/main` the whole time - another reason to read it directly.

**Detached HEAD is not an error.** `git branch --show-current` returns an empty string with **exit code 0**. Nothing signals the state; you just get a blank.

**Worktree vs submodule `gitdir:` pointers differ, and this is the easy bug.** Both replace `.git` with a file, but:

- worktree → **absolute** path (`gitdir: /Users/k/repo/.git/worktrees/wt`)
- submodule → **relative** path (`gitdir: ../.git/modules/sub`)

Resolving against the process cwd silently reports the *superproject's* branch for a submodule. Resolve against the directory holding the pointer file - correct for both, since `path.resolve` ignores the base when the value is absolute.

**`git am` shares `rebase-apply/` with `git rebase`.** A conflicted `git am` leaves the directory behind but writes **no `head-name`**, and does not detach HEAD. Reading the file without checking it exists yields `undefined (rebasing)` over a perfectly ordinary branch.

**Merge, cherry-pick and revert do not detach.** HEAD stays a symref; they only add a suffix. Only rebase and bisect detach, and both record the original branch (`rebase-merge/head-name`, `BISECT_START`) - so a detached HEAD should consult those before falling back to the short SHA.

**Bidi characters in branch names are real.** Git accepts U+202E RIGHT-TO-LEFT OVERRIDE and zero-width spaces in a ref name (verified), which reorder or hide adjacent status-line text. Strip `\p{Cf}` before rendering, and wrap the name in `<bdi>` so an RTL name cannot reorder what sits next to it.

---

## electron-vite dev: a stale main process looks like a missing IPC handler

**Problem:** After adding a new `ipcMain.on` handler plus a preload method, the renderer had the new code and `window.fleet.agent.watchGit` existed on the bridge, but the IPC round trip timed out every time. Every layer checked out individually - `out/main/index.mjs` contained the handler registrations, and running the main-side functions under `tsx` returned the right answer.

**Cause:** The Electron process was an orphan from an earlier dev run. Vite HMR'd the **renderer**, and reloading the window picked up the new **preload** bundle, but **main** was never restarted and so never registered the new handlers. The result is a silent no-op rather than an error: the renderer sends into a channel nobody is listening on.

**Fix:** Fully restart `npm run dev`. Nothing less will do - main process changes need a real process restart.

**How to recognise it:** preload additions appear on `window.fleet` (proving the renderer reloaded) while `ipcMain` handlers behave as if absent. If the handler is present in `out/main/index.mjs` and works under `tsx`, suspect the process, not the code.

**How to avoid making it worse:** don't repeatedly kill and restart the dev server to investigate. The Bash tool's process table is sandboxed and only shows a fraction of the user's processes, so `ps`/`pkill` give a misleading picture and it is easy to kill the user's app while leaving orphans behind - or to kill everything, which is what happened here. Check `lsof -nP -iTCP:5173 -sTCP:LISTEN` to see what actually holds the dev port, and ask the user to restart rather than cycling it.
