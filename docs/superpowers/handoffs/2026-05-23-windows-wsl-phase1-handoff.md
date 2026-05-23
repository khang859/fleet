# Windows + WSL First-Class Support — Phase 1 Handoff

**Date:** 2026-05-23
**Status:** Phase 1 (Foundation) shipped to `main`. Phases 2–6 remain.
**Author context:** Khang runs Fleet on Windows + WSL and hit pain around the launch experience (tab title shows `/mnt/c/...` Windows path, unclear if WSL started, etc.).

---

## TL;DR for the next session

Phase 1 landed the data primitives + IPC plumbing for first-class Windows/WSL support — **zero user-visible behavior change yet.** Everything Phase 2 needs (`ShellProfile`, `WslService`, `window.fleet.shellProfiles.list()`, `window.fleet.wsl.*`) is wired and tested. Next phase plugs these into `PtyManager` and fixes the actual launch UX.

**Phase 2 starting point:** Read `docs/superpowers/specs/2026-05-22-windows-wsl-first-class-design.md` §"Phase 2 — Launch fix" (the spec already breaks the rollout into 6 phases). Then write a TDD plan for Phase 2 using `superpowers:writing-plans`.

---

## Reference documents

| Doc | Purpose |
|---|---|
| `docs/superpowers/specs/2026-05-22-windows-wsl-first-class-design.md` | Locked design spec for all 6 phases. Read this first. |
| `docs/superpowers/plans/2026-05-22-windows-wsl-foundation.md` | The 17-task Phase 1 plan that just shipped. Useful as a template for Phase 2's plan. |
| This file | Handoff state + Phase 2 starting context. |

---

## What Phase 1 shipped

18 commits on `main`, from `df1acc6` → `ff742d3`. Diff: +938 / -116 across 14 files (most of the delete is `package-lock.json` reshuffle from adding `iconv-lite`).

### Files added

| File | Purpose |
|---|---|
| `src/shared/shell-profiles.ts` | Types: `PathContext`, `WslDistro`, `WslDistroState`, `ShellProfile`, `ShellProfileKind`, `LEGACY_SYSTEM_DEFAULT_ID` |
| `src/shared/path-platform.ts` | Pure functions: `isWindowsPath`, `isWslPath`, `basename(p, ctx)`, `join(ctx, ...segs)`, `displayPath(p, ctx, homes)` |
| `src/shared/__tests__/path-platform.test.ts` | 27 unit tests for path-platform |
| `src/main/wsl-service.ts` | `WslService` class with `parseListVerbose` (UTF-16LE+BOM), `listDistros`, `homeDir`, `toWslPath`/`toWinPath`, `status`, `warmUp`. Injectable `WslExec` for testing. |
| `src/main/__tests__/wsl-service.test.ts` | 15 unit tests for WslService (all with mocked exec) |
| `src/main/shell-profiles.ts` | `ShellProfileRegistry` class. `enumerate()` returns ShellProfile[] for current platform. `defaultFileExists` exported for prod wiring. |
| `src/main/__tests__/shell-profiles.test.ts` | 4 unit tests covering posix/win32/git-bash/wsl enumeration |

### Files modified

| File | Change |
|---|---|
| `src/shared/ipc-channels.ts` | +5 channels: `SHELL_PROFILES_LIST`, `WSL_STATUS`, `WSL_TO_WSL_PATH`, `WSL_TO_WIN_PATH`, `WSL_HOME_DIR` |
| `src/shared/ipc-api.ts` | +7 request/response types (one import line + types appended at EOF) |
| `src/main/ipc-handlers.ts` | +2 trailing params to `registerIpcHandlers` (`shellProfileRegistry`, `wslService`); +5 `ipcMain.handle` blocks at bottom |
| `src/main/index.ts` | Instantiate `WslService` and `ShellProfileRegistry` at module top; pass to `registerIpcHandlers` |
| `src/preload/index.ts` | Expose `window.fleet.shellProfiles.list()` and `window.fleet.wsl.{status, toWslPath, toWinPath, homeDir}` |
| `package.json` | Added `iconv-lite` to dependencies |

### Verification state at handoff

- `npm test`: **493/493 pass** (was ~470 before Phase 1)
- `npm run typecheck`: clean
- `npm run lint`: pre-existing warnings remain, but our diff added zero new errors/warnings (after the `style:` cleanup commit)
- `npm run build`: clean

---

## Key technical decisions worth remembering

These are the locked-in choices that future phases should NOT relitigate:

### 1. `PathContext` as a discriminated union, not a string

```ts
type PathContext = 'posix' | 'win32' | { kind: 'wsl'; distro: string };
```

WSL needs the distro name to translate paths, so it's an object. The two native cases stay as string literals for ergonomic discrimination (`ctx === 'win32'`).

### 2. `WslService` takes an injectable `WslExec`

All wsl.exe invocations go through `this.exec(cmd, args, options)`. In production it's `defaultExec` (wraps `child_process.spawn`, returns `{stdout: Buffer, stderr: Buffer}`). In tests, callers pass `vi.fn().mockResolvedValue(...)`. **This made all 15 service tests fast and platform-independent — even on Linux test hosts.**

### 3. UTF-16LE with BOM is a real pitfall

`wsl.exe` emits UTF-16LE with a `0xFF 0xFE` BOM on stdout. The first bug I'd have hit without testing for it. `parseListVerbose` calls `decodeWslOutput(buf)` which strips the BOM and uses `iconv-lite` to decode. The tests construct fixtures with the BOM explicitly to exercise the decode path.

### 4. `wsl --list --verbose` over `--list --quiet`

The previous shell-detection code used `--quiet` which returns names only. We need state + version, so all queries use `--verbose`. State strings (`'Running'`, `'Stopped'`, `'Installing'`) are lowercase-normalized in `mapState`.

### 5. `wslpath` for translation, not regex

`wsl -d <distro> --exec wslpath -u <winpath>` (or `-w` for the reverse). Each distro can have different mount roots, so we shell out *inside the distro*. Results are cached per `${distro}:${path}` key.

### 6. Errors propagate from `toWslPath`/`toWinPath`/`homeDir`

Unlike `listDistros`/`status` which catch and return sentinels, the path-translation methods rethrow on `wslpath` failure. **The test for `toWslPath` literally asserts `rejects.toThrow('wslpath')` — this is intentional.** Callers decide what to do (Phase 2 will surface as a UI error).

### 7. `path.win32.join`, not `path.join`

`ShellProfileRegistry` constructs the Git Bash path using `path.win32.join` so the same code produces backslash-separated paths on any host (test or production). The originally-planned `path.join` would have used forward slashes on Linux CI and broken the unit test's mock.

### 8. Plan defect: `expect.anything()` doesn't match `undefined`

The plan's spec for WslService methods showed `this.exec(cmd, args)` with no third arg, but the tests asserted on the third arg via `expect.anything()`. Vitest's `expect.anything()` does NOT match undefined. **Every exec call in WslService passes `{}` as the third arg to satisfy the assertion.** If you refactor, keep this pattern (or change all the tests to drop the third-arg assertion).

### 9. Dual `shell-profiles.ts` files are intentional

- `src/shared/shell-profiles.ts` — cross-process types
- `src/main/shell-profiles.ts` — main-process `ShellProfileRegistry` class

If your editor fuzzy-finder confuses them, scope by directory. Renaming either would break the convention (`src/shared/` = shared types, `src/main/` = main-process impl).

### 10. `LEGACY_SYSTEM_DEFAULT_ID` exists but is unused

It's forward scaffolding for Phase 3's layout migration. Don't delete it as dead code.

---

## What Phase 2 (Launch fix) needs to do

Per the spec, Phase 2 is the smallest user-visible win — it fixes the launch UX bugs that motivated this whole thing. **All the primitives exist; no new types or IPC needed.**

**Bugs Phase 2 fixes:**

1. **WSL launches with `/mnt/c/...` cwd instead of `$HOME`.** Today `PtyManager.create` passes the Windows cwd directly into `wsl.exe`, which auto-translates it to a mounted path. Fix: spawn `wsl.exe -d <distro> ~` (or `--cd ~`) so the shell starts in `$HOME` regardless of what cwd Electron passes.

2. **Tab title shows `/mnt/c/Users/...` instead of `~/...`.** `workspace-store.ts:102` (`cwdBasename`) splits only on `/`, so Windows paths and `/mnt/c/...` paths look ugly. Fix: route through `displayPath(p, ctx, homes)` from path-platform — needs the pane's `pathContext` and a `homes` snapshot.

3. **No CWD updates on Windows.** `cwd-poller.ts:60` returns `null` on `process.platform === 'win32'`. Fix: use `pid-cwd` (already a dep) for Windows native PTYs; use OSC 7 for WSL panes (Phase 3 will install the hook in `~/.fleetrc.sh`).

**Phase 2 file map (predicted, not locked):**

| File | Change |
|---|---|
| `src/main/pty-manager.ts` | Accept `profile: ShellProfile` in `PtyCreateOptions`. For WSL profiles, spawn `wsl.exe -d <distro> ~` (or `--cd ~`). Record `pathContext` on the PtyEntry. |
| `src/main/cwd-poller.ts` | Add `pid-cwd` branch for win32. Keep linux/darwin paths intact. |
| `src/renderer/src/store/workspace-store.ts:102` | Rewrite `cwdBasename` to use `path-platform.basename(p, ctx)`. Needs pane to carry `pathContext`. |
| `src/shared/ipc-api.ts` | Extend `PtyCreateRequest` with `profileId: string` (resolves to a ShellProfile in main). |
| `src/renderer/...` | Wherever PTY create gets called, pick a ShellProfile (Phase 4 adds the picker; for Phase 2 use the default profile). |

**Phase 2 acceptance criteria:**

- On Windows: opening a new WSL pane lands in `$HOME` (`~`), and the tab title shows `~` or a child path collapsed against `~`.
- On Windows: changing directory in a native cmd/PowerShell pane updates the tab title (poller picks it up via pid-cwd).
- macOS/Linux: zero regression. Existing flow still works.
- Existing tests still pass.

**Phase 2 should NOT touch:**

- The picker UI (Phase 4).
- Bridge socket changes (Phase 4 or 5).
- `~/.fleetrc.sh` hook installation (Phase 3 + 5).
- Persistent workspace defaults (Phase 4).

---

## Open caveats for Phase 2 to address

From the final code review of Phase 1:

1. **The three path-translation IPC handlers leak raw `wsl.exe` exceptions to the renderer.** Today no renderer code calls them, so it's not a shipped bug — but Phase 2 will be the first consumer. Either wrap each handler in `try/catch` and return `{ ok: false, error: msg }`, or use a renderer-side wrapper that converts rejections to user-visible toasts. Pick one before Phase 2 ships.

2. **`shellProfileRegistry.enumerate()` runs on every IPC call.** No caching. For Phase 2 (one call at pane creation) that's fine, but Phase 4's picker may want a cached list with explicit `refresh()`.

3. **`WslService` caches never invalidate.** `homeDir`, `toWslPath`, `toWinPath` are cached for the process lifetime. If a user uninstalls a distro mid-session, the cache lies. Acceptable for Phase 1; revisit if it becomes a problem.

---

## Useful artifact references

- **Plan-as-template:** `docs/superpowers/plans/2026-05-22-windows-wsl-foundation.md` is a working example of the writing-plans format (17 TDD tasks, exact code per step, expected test counts). Phase 2 should look similar.
- **Spec section to start from for Phase 2:** Search the spec for "Phase 2" — it has acceptance criteria and pitfalls already documented.
- **Subagent-driven execution worked well for Phase 1.** 17 tasks × (implementer + spec review + code review) = ~50 subagent dispatches. Total wall time was a few hours of supervised dispatch. Recommended again for Phase 2.

---

## Starting prompt for the next session

> "I'm continuing work on Fleet's first-class Windows+WSL support. Phase 1 (Foundation) just shipped to main — see `docs/superpowers/handoffs/2026-05-23-windows-wsl-phase1-handoff.md` for the state. Read that, then read the spec at `docs/superpowers/specs/2026-05-22-windows-wsl-first-class-design.md` §Phase 2, and write the Phase 2 implementation plan using superpowers:writing-plans."

That's enough context for the next session to pick up cold.
