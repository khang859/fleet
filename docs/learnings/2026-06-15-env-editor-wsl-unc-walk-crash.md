# Learnings: Env Editor crashed Fleet when opened from a WSL pane (2026-06-15)

## A synchronous directory walk over the `\\wsl.localhost` 9P share froze/killed the main process

**Problem:** On Windows, opening the Env Editor from a **WSL pane** took the
whole app down (and restoring a WSL pane was already hanging). The Env Editor's
`ENV_EDITOR_LIST` handler ran:

```ts
listEnvFiles(resolveCtxPath(pathContext, root))
```

For a WSL pane, `resolveCtxPath` rewrites the pane's posix cwd into a
`\\wsl.localhost\<distro>\…` UNC path (Strategy 1, the UNC bridge from #250).
`listEnvFiles` then walks it **synchronously** with `readdirSync` + `statSync`,
recursing to depth 4. A synchronous recursive walk over the WSL 9P network
share blocks the main process event loop — and can hard-fault it — so the app
froze/crashed. Native (macOS/Linux/Windows-non-WSL) never hit this: there's no
UNC bridge, so the walk is local and fast.

The tell was the sibling handler: #250 gave **FILE_LIST** a WSL branch
(`listFilesWsl`) that runs `git`/`find` *inside* the distro via
`execInContext`, explicitly to avoid walking posix paths from the win32 side.
`ENV_EDITOR_LIST` was the one discovery path left on the synchronous UNC walk —
an architectural inconsistency, not a typo, which is why it only repro'd on
Windows + WSL.

**Fix:** Mirror `listFilesWsl`. New `src/main/env-editor/env-editor-wsl.ts`
(`listEnvFilesWsl`) discovers `.env*` files *inside* the distro via
`find … -prune … -name '.env*'` over `execInContext` (which has a 15s timeout,
so a stopped distro returns instead of hanging). Per-file reads for the
var-count badge use **async** `fs/promises` over the UNC bridge — a slow distro
yields a slow promise, never a frozen event loop. Returned `absPath`s are UNC,
so READ/WRITE/RENAME/DELETE (which take an `absPath` with no context) keep
working unchanged. The handler branches on `isWslContext(pathContext)`; the
native path is byte-for-byte the old `listEnvFiles(root)`.

Entry-shaping (group/name/template/varCount) was extracted into
`buildEnvEntry()` in `env-editor-fs.ts` and shared by both walkers so their
output stays identical.

**Rule of thumb:** Anywhere the main process touches a WSL pane's filesystem,
do it *inside the distro* (`execInContext`) or with **async** fs over the UNC
bridge — never a synchronous `readdirSync`/`statSync` walk across
`\\wsl.localhost`. When adding a per-pane feature, check every sibling handler
got the WSL branch, not just the obvious one.

**Note / still open:** WSL pane *restore* hanging is a separate issue (not
fixed here) — worth its own look.
