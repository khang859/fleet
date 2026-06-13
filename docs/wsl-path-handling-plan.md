# WSL ↔ Windows Path Handling — Implementation Plan

> Status: **Phase 0 + 1 + the Phase 2 paste/quote slice + Phase 3a (read-only query tools)** are implemented. Phase 3a = `runInPathContext` foundation + git (Git Changes), file-list/check-ignore, file-grep, file-search, plus the FILE_READDIR UNC bridge that browse-mode needs — all run *inside* the distro for WSL panes and return POSIX paths. Remaining: Phase 2 (remainder), **Phase 3b** (env-editor/env-sync, worktrees/kanban — the write/workflow tools, which depend on the `GIT_REPO_ROOT`-stays-POSIX semantics change §13.4) and Phase 4. Known follow-up: opening a WSL grep/files/search *result* in the in-app editor still needs FILE_READ/STAT/READ_BINARY routed through the UNC bridge + the editor pane carrying the file's `pathContext` (a separate viewing slice); the Telescope **paste** action already works via Phase 2.

## 1. Runtime model (confirmed)

Fleet runs as a **native Windows process** (`process.platform === 'win32'`). The user opens **WSL shells inside panes** via `wsl.exe -d <distro> --cd ~`. So:

- The **main process** thinks in Windows coordinates: `os.homedir()` → `C:\Users\khang`, sockets are named pipes, `dialog.*` returns Windows paths, `git.exe`/`rg`/`es.exe` are Windows binaries.
- The **WSL pane's** shell, files, and live cwd (via OSC 7) are in Linux coordinates: `/home/khang/...`.
- Live-env facts (this machine): distro `Ubuntu-24.04`; UNC form `\\wsl.localhost\Ubuntu-24.04\...` (modern, not legacy `\\wsl$\`); automount root `/mnt`; `C:` ↔ `/mnt/c`; `wslpath` available.

## 2. Root cause (single, systemic)

**There is no translation boundary between win32 coordinates and WSL coordinates**, although all the infrastructure already exists and is wired but unused:

| Existing infra | File | Current use |
|---|---|---|
| `WslService.toWslPath / toWinPath / homeDir` (via `wslpath`, cached) | `src/main/wsl-service.ts` | Only `homeDir`, for display |
| IPC `WSL_TO_WSL_PATH` / `WSL_TO_WIN_PATH` / `WSL_HOME_DIR` + `window.fleet.wsl.*` | `ipc-handlers.ts:843-865`, `preload/index.ts:486-509` | `homeDir` only |
| `pathContext: 'win32' \| 'posix' \| {kind:'wsl',distro}` stamped on every `PaneLeaf`/`Tab` | `src/shared/shell-profiles.ts:9`, `types.ts:54-56,83-85` | Read by cwd-poller + Telescope only |
| `path-platform.ts` (`winToWslMountPath`, `isWslPath`, `join`, `basename`, `displayPath`) | `src/shared/path-platform.ts` | `displayPath`/`basename` only |
| `homes-store.wslHomeByDistro` | `src/renderer/src/store/homes-store.ts` | Read by Telescope only |

Features read `window.fleet.platform` (always `'win32'`) and `window.fleet.homeDir` (always `C:\Users\...`) instead of the pane's `pathContext`.

## 3. Design principles — three translation strategies

The fix is a **centralized translation boundary keyed on `pathContext`**, never ad-hoc per feature. There are exactly three coordinate problems, each with a distinct strategy:

1. **Serve/read a WSL file from the win32 process → UNC bridge.**
   `\\wsl.localhost\<distro>\<posix>` is natively readable by Windows `fs`. Pure string transform given the distro (no subprocess). Use for: protocol handlers, `FILE_READ/WRITE/STAT/READDIR/READ_BINARY`, recent-images scan, slideshow scan, image gallery.
   - `/mnt/<drive>/...` POSIX paths are *really* Windows drive paths → map to `<drive>:\...` directly (faster, avoids the 9P share). Everything else `/...` → UNC.

2. **Run a Windows CLI tool against a WSL repo → execute inside WSL, not against a UNC cwd.**
   Windows `git.exe`/`cmd.exe` are unreliable with UNC cwds, and we *want* the user's WSL git config + the repo's true path. So run `wsl.exe -d <distro> --cd <posix> --exec <tool> ...` instead of spawning the Windows tool with `cwd: <unc>`. Use for: git status/changes, file-search, file-grep, env-sync, worktrees, kanban workspaces, `FILE_LIST`/`FILE_CHECK_IGNORED`.

3. **Paste a path into a WSL shell → convert + quote per pane `pathContext`.**
   `quotePathForShell` must take the pane's `pathContext`, not `window.fleet.platform`; the path must be in the pane's coordinate system (POSIX for WSL). Use for: drag-drop, Telescope modes, FileSearchOverlay.

**Canonical URL rule:** never string-concat `file://` + path. Per Context7, the supported Electron pattern is `net.fetch(pathToFileURL(absPath).toString())`; for UNC, fall back to `readFile` + `Response` (see §10 unknown). All renderer→protocol URLs go through one builder that puts the path in the URL **path** position (empty authority), per-segment encoded.

## 4. Cross-cutting helper: read the active pane's `pathContext`

No getter exists today; callers hand-traverse `workspace.tabs → findLeaf`. Add one:

- **`src/renderer/src/store/workspace-store.ts`** — export `getActivePaneContext(): { pathContext: PathContext; cwd: string; paneId: string }`. Resolve `activeTabId` → `findLeaf(splitRoot, activePaneId)` → return `leaf.pathContext ?? tab.pathContext ?? (window.fleet.platform === 'win32' ? 'win32' : 'posix')` and the live cwd from `useCwdStore`. (`findLeaf` is currently private at `workspace-store.ts:351` — export it or wrap it.)

Every renderer feature that builds/pastes a path uses this instead of `window.fleet.platform`/`homeDir`.

## 5. Phase 0 — Shared foundation (pure, testable, no behavior change)

**`src/shared/path-platform.ts`** — add pure functions + unit tests (`__tests__/path-platform.test.ts`). Heed `docs/learnings/2026-04-25-ci-os-specific-path-assertion.md`: assert against the API, never a hardcoded OS prefix.

- Export the currently-private `winToWslMountPath` (line 48) and add its inverse `wslMountToWinPath('/mnt/c/x' → 'C:\\x')`.
- `toWslUncPath(distro, posixPath)` → `\\wsl.localhost\<distro>\<segs joined with \>`.
- `parseWslUncPath(p)` → `{ distro, posixPath } | null`, accepting `\\wsl.localhost\` **and** `\\wsl$\`, forward or back slashes.
- `toWindowsAccessiblePath(path, pathContext)` → the Strategy-1 resolver: win32 passthrough; wsl + `/mnt/<d>/` → drive path (**single drive letter only** — `/mnt/wsl/`, `/mnt/wslg/` fall through to UNC); wsl + `/...` → UNC; wsl + already-UNC/drive → passthrough.
- `pathForPaneContext(path, pathContext)` → Strategy-3 converter for pasting: wsl ctx + `C:\` → `/mnt/c/...`; wsl ctx + UNC(same distro) → POSIX; win32 ctx + UNC → keep; else passthrough.
- `toFleetImageUrl(absPath)` and `toFleetPdfUrl(absPath)` → canonical builders. Put the path in pathname (empty authority), per-segment `encodeURIComponent`. Must round-trip drive paths, UNC, and POSIX. (Fixes the latent `new URL('fleet-image://C:/..')`-drops-drive-letter bug.)

**`src/main/wsl-path.ts`** (new, main-side) — thin async helper `resolveForMain(path, pathContext)` that prefers the pure `toWindowsAccessiblePath`, and only falls back to `wslService.toWinPath(distro, path)` for non-standard automount roots (custom `/etc/wsl.conf` `automount.root`). Cache by `(distro, path)`.

## 6. Phase 1 — Tier 1: serve & read WSL files

**`src/main/index.ts:282-307`** (protocol handlers):
- Extract path-resolution into `src/main/protocol-paths.ts` (pure, unit-tested) so it gets coverage without Electron.
- **Defensive URL parsing (required, not optional):** `new URL(request.url)` **provably throws `Invalid URL`** for the legacy backslash shapes the renderer emits today (`fleet-image://C:\Users\...` raw, and `encodeURI`'d `fleet-image://C:%5C...` — the `%5C` lands in port position). A throw inside `protocol.handle` is an unhandled rejection. Wrap in try/catch with a manual fallback (`request.url.slice('fleet-image://'.length)` → decode → slash-normalize). *(Empirically confirmed by validation, see §10.)*
- `fleet-image` / `fleet-pdf`: parse the real path from the URL (path position), branch drive/UNC/POSIX→UNC. **Serve UNC via `readFile` + `new Response(data, {headers:{'Content-Type':mime}})` as the PRIMARY path** (the proven `fleet-asset` pattern, `docs/learnings/2026-03-29-custom-protocol-privileges-packaged.md`; Node `fs` handles UNC natively). Use `net.fetch(pathToFileURL(p).toString())` only for plain local drive/POSIX paths — do **not** rely on `net.fetch` for UNC (Windows-only unknown, §10.1).
- Keep a back-compat branch **only** for the forward-slash `host === driveLetter` shape (e.g. `ImageDetail.tsx:19`'s `homeDir + '/...'` concat). Note: stored settings hold *paths*, not URLs, and the renderer rebuilds every URL through the new builder each render — so old stored values are fixed by the builder, **not** by this branch. The branch is cheap insurance for the forward-slash case, nothing more.
- **Do NOT add `standard: true`** to `fleet-image`/`fleet-pdf`. A standard scheme re-canonicalizes the URL (host extraction, slash collapsing), which breaks the new empty-authority contract (`fleet-image:///C%3A/...` and the quad-slash `fleet-image:////wsl.localhost/...` UNC form). No relative resolution is needed for `<img src>`; keep them non-standard with the current `supportFetchAPI + stream` privileges.

**Renderer URL construction** — replace every hand-built `` `fleet-image://${p}` `` / `encodeURI(...)` with `toFleetImageUrl` / `toFleetPdfUrl`:
- `BackgroundLayer.tsx:65`, `settings/BackgroundPreview.tsx:38`, `settings/BackgroundThumbnails.tsx:83`, `hooks/use-slideshow.ts:22`, `ImageViewerPane.tsx:62`, `PdfViewerPane.tsx:77`, `Sidebar.tsx:227`, `ImageGallery/ImageGrid.tsx:16`, `ImageGallery/ImageDetail.tsx:19`, `AnnotateTab.tsx:120,184`, `FileSearchOverlay.tsx:173`.

**Recent-images ("Screenshots")** — `src/main/recent-images.ts:96-120` `searchRecentImages(opts?)`: also scan the active pane's WSL dirs. Thread `pathContext` through IPC `FILE_RECENT_IMAGES` (`ipc-handlers.ts:585`) and preload (`preload/index.ts:311`); when `{kind:'wsl',distro}`, resolve `await wslService.homeDir(distro)`, build UNC dirs `\\wsl.localhost\<distro>\<home>\{Desktop,Downloads,Pictures}` (+ the home root, since Linux screenshots often land in `~`). The WSL branch must **NOT reuse the existing `recursive: true` readdir** at `recent-images.ts:104` — use a **depth-1 readdir with a time budget** (9P perf); existing `STAT_LIMIT`/`SCAN_RESULT_LIMIT` bound the rest. Guard with a timeout that degrades to "Windows-only results" if the distro is stopped/cold-booting (a UNC read can cold-start the VM, multi-second). `FileSearchOverlay.tsx:330` passes the context on open.

> **Sequencing hazard (validated):** Phase 1 makes WSL recent-images *appear* in FileSearchOverlay, but selecting one still hits the Phase-2-untouched `quotePathForShell(file.path, window.fleet.platform)` at `FileSearchOverlay.tsx:397` → pastes a double-quoted UNC/Windows path into a bash pane. **Ship the FileSearchOverlay paste fix (Phase 2) together with Phase 1**, or gate WSL recent-image *results* until Phase 2 lands.

**Generic file IPC** — `FILE_READ/WRITE/STAT/READDIR/READ_BINARY/LIST` (`ipc-handlers.ts:475-576`): accept an optional `pathContext` and run the raw path through `resolveForMain` before `readFile`/`readdir`/etc. (UNC bridge). For `FILE_LIST`/`FILE_CHECK_IGNORED` see Phase 3 (they shell out to git). Note: `FILE_WRITE` over the 9P UNC share works but fresh files get default Linux metadata (perms/ownership from the 9P server), not the editing user's — acceptable for editor saves, worth being aware of.

**Slideshow scan** — `slideshow-scanner.ts` already uses `readdir`+`join`; works on UNC once stored paths are Windows-accessible. The dialog already returns Windows/UNC paths (Strategy-1 not needed at write time); only legacy POSIX `imagePath` needs the read-time fallback in the handler.

## 7. Phase 2 — Tier 2: paste & quote paths

**`src/renderer/src/lib/shell-utils.ts`** — change `quotePathForShell(path, pathContext: PathContext)` (was `platform: string`): single-quote for `posix`/`wsl`, double-quote for `win32`. Update all 4 callers to pass the **pane** context and to convert the path first via `pathForPaneContext`:
- `hooks/use-terminal-drop.ts:8` (drag-drop — `getPathForFile` returns a Windows path; convert to `/mnt/c/...` for WSL panes). **Use the async `window.fleet.wsl.toWslPath` (existing, cached) here, not the pure `pathForPaneContext`** — the pure `/mnt/c` heuristic is wrong under a custom `automount.root` in `/etc/wsl.conf`; drag-drop is already async so this is free. Pure function is the fallback only.
- `components/FileSearchOverlay.tsx:397`,
- `components/Telescope/modes/files-mode.ts:81`,
- `components/Telescope/modes/browse-mode.ts:127`.

**Telescope/FileSearch path display** — `FileSearchOverlay.tsx:574` and `Telescope/*` use `.replace(window.fleet.homeDir, '~')`; switch to `displayPath(p, ctx, useHomesStore.getState().snapshot())` so `~` collapses correctly for WSL panes.

**Note on path sources:** `FILE_LIST`/`FILE_READDIR` currently build paths with main-process `path.join` (Windows separators) over a POSIX `dirPath` → produces mangled `\home\khang\...`. Fixing the spawn-in-WSL path (Phase 3) makes these return clean POSIX paths, which then paste correctly.

## 8. Phase 3 — Tier 3a: run Windows tools inside WSL

Replace "spawn Windows tool with `cwd: <posix>`" with "spawn inside the distro." Add a main-side helper `runInPathContext(pathContext, argv, opts)` that, for `{kind:'wsl',distro}`, prefixes `wsl.exe -d <distro> --cd <posix> --exec` and otherwise spawns natively. Thread `pathContext` into each IPC (the renderer already knows it per pane).

> **`--exec` is argv-only (no shell):** validated — `wsl.exe -d <distro> --cd <posix> --exec git rev-parse ...` works (exit 0), but `--exec` passes argv verbatim with no shell, so anything needing pipes/globs/quoting must use `-- sh -c '...'` instead. In particular `FILE_CHECK_IGNORED` (`ipc-handlers.ts:544-546`) currently builds a single-quoted shell string with a glob — migrate it to argv form (`--exec git check-ignore -- <names...>`), which also removes an injection-adjacent pattern (deliberate improvement). Every `runInPathContext` spawn needs a timeout (a stopped distro cold-boots the VM).

- **Git** — `src/main/git-service.ts:11-14` (`simpleGit({baseDir})`), IPC `GIT_IS_REPO/REPO_ROOT/STATUS` (`ipc-handlers.ts:322-331`). For WSL panes, run `git` inside WSL (either `simpleGit` with a `wsl.exe git` shim, or shell out via `runInPathContext`). This fixes Git Changes toolbar.
- **File list / check-ignore** — `ipc-handlers.ts:415-471,536-554` (`git ls-files`, `git check-ignore`) → run inside WSL; return POSIX paths.
- **File grep** — `src/main/file-grep.ts` (`rg`/`grep`) → run inside WSL (uses the distro's `rg`/`grep`).
- **File search** — `src/main/file-search.ts:22-47` → for WSL panes, run `locate`/`find` inside WSL instead of Windows `es.exe`.
- **Env-editor / env-sync** — `env-editor/env-editor-fs.ts` (`listEnvFiles`; `softDeleteEnvFile` at :150 uses Windows `tmpdir()`), `env-sync/env-sync-config.ts` (`findNearestConfig` walks a POSIX path with the Windows `path` module). The real defect is that the untranslated POSIX path never resolves at all on win32 — route fs through the UNC bridge. *(Correction: `moveFile` at `env-editor-fs.ts:140-146` already handles `EXDEV` via copy+unlink, so cross-fs rename is not the bug; moving trash to a WSL-side temp dir is a restore-semantics/perf nice-to-have, not a fix.)*
- **Worktrees / kanban workspaces** — `worktree-service.ts` (`simpleGit({ baseDir: repoPath })` at **:124**, also :160/:178/:216; worktree base built at **:120**), `kanban/workspace.ts:34-150` + `mkdirSync(worktreesRoot)` at `:98` (`git worktree add` with POSIX `repoPath`) → run inside WSL; worktree base must live on the **same filesystem as the repo** (a WSL path), not `C:\Users\..\.fleet\worktrees` — use a WSL-side `mkdir -p` when the repo is WSL. *(Plan previously cited `:85-104`, which is a codename word list — wrong; corrected here.)*

## 9. Phase 4 — Tier 3b/3c: sessions & the `fleet open` CLI boundary

**Session readers** — `sessions/claude-source.ts:18` (`~/.claude/projects`), `sessions/rune-source.ts:281` (`~/.rune/sessions`), `copilot/conversation-reader.ts:16-22`. Claude/Rune running **inside WSL** write to the Linux home; Fleet reads the Windows home → sessions invisible. For WSL panes, read from `\\wsl.localhost\<distro>\<wslHome>\.claude\projects` etc. `cwdToProjectDir` must encode the POSIX cwd consistently with how Claude-in-WSL encodes it.

**`fleet open` CLI socket** — `src/shared/constants.ts:26-34`, `src/main/fleet-cli.ts`, `src/main/socket-server.ts:218-246`. Two boundary problems:

1. *Transport — **TCP rejected, use reverse interop instead** (validated):* the CLI in WSL connects to the **posix unix socket** `~/.fleet/fleet.sock`; the Windows app listens on a **named pipe** `\\.\pipe\fleet`. They can't meet.
   - ❌ **The original "app also binds localhost TCP" idea is empirically wrong here:** this machine is `nat` mode (`wslinfo --networking-mode` → `nat`; default gateway `192.168.32.1`), so `127.0.0.1` inside WSL is the WSL VM, not Windows. Reaching the host needs the gateway IP + binding a non-loopback interface + fighting the Hyper-V firewall. Mirrored mode makes localhost work but is opt-in/Win11-22H2+. A TCP control port also has no OS ACL (the pipe/`0700` socket get one free), so it would need a token handshake.
   - ✅ **Recommended: reverse WSL interop.** The CLI in WSL detects `$WSL_DISTRO_NAME` and re-execs the **Windows** CLI against the named pipe: `ELECTRON_RUN_AS_NODE=1 <win-install>/Fleet.exe <…>/fleet-cli.cjs open … --distro "$WSL_DISTRO_NAME" --cwd "$(pwd)"` (forward the env var via `WSLENV=ELECTRON_RUN_AS_NODE`). The spawned process is Windows node, so `SOCKET_PATH` correctly evaluates to `\\.\pipe\fleet` — no firewall, no auth gap, works in NAT *and* mirrored, response channel is stdout. The CLI validates paths POSIX-side first and passes `{distro, posixPath}`.
   - *(If TCP is ever kept anyway: require a discovery file `C:\Users\<u>\.fleet\cli.json` `{port, token}` read from WSL via `/mnt/c/...`, per-connection token auth, and a connect-to-gateway-IP fallback for NAT.)*
2. *Path + pane kind:* the CLI is a Linux process — it already knows `$WSL_DISTRO_NAME` and its POSIX `process.cwd()`. Tag the `file.open`/`pi`/`plan_open` request with `{ distro, posixPath }` so the Windows app **opens a WSL pane in that distro at that cwd** and translates the path via the UNC bridge for any `existsSync`/`readFile`. *(Correction: `fleet-cli.ts:696` `resolve(p)` already runs in the CLI/Linux process and is correct — the fix is only "tag with `{distro, posixPath}`", not "move resolution". The main-side resolution that actually breaks is the **Pi-extension fleetBridge**, below.)*

**Pi-extension fleetBridge (separate, easier boundary)** — `src/main/index.ts:~448` does `resolve(rawPath)` + `existsSync` in **win32 coordinates** for an agent-supplied path. This is a *different* transport from the CLI socket (agent → bridge, no TCP/pipe change needed) but the same coordinate bug. Fix: translate via the originating pane's `pathContext` (the bridge knows it from `paneId`) through the UNC bridge before `existsSync`/`readFile`. List as its own item.

**CLI install** — `install-fleet-cli.ts:253` skips on win32 (writes wrapper + PATH to the Windows home), so WSL shells never get `fleet`. For WSL support, install the wrapper into the WSL home and append PATH to the WSL shell rc (write via the UNC bridge or `wsl.exe … --exec`).

## 10. Empirical unknowns — must verify on a real Windows box

Validation settled several of these from the WSL side; the remaining true unknowns are Windows-only. Settled vs open:

**Settled (validated in WSL):**
- ✅ The `fleet-image://` URL bug is confirmed and worse than "drops drive letter": forward-slash `fleet-image://C:/...` → host `C` (drive dropped); **raw and `encodeURI`'d backslash shapes throw `Invalid URL`** → handler needs try/catch (§6). The proposed empty-authority builder (`fleet-image:///C%3A/...`, `fleet-image:////wsl.localhost/...`) round-trips correctly for drive/UNC/POSIX incl. spaces/Unicode/`#`/`?`.
- ✅ `wsl.exe -d <distro> --cd <posix> --exec <tool>` works (git/pwd verified, exit 0) → run-inside-WSL for Tier 3 is viable.
- ✅ NAT networking confirmed on this machine → localhost-TCP transport rejected (§9).
- ✅ UNC form `\\wsl.localhost\Ubuntu-24.04\...`; `/tmp` and tmpfs paths are also reachable via the share; `C:\Users` ↔ `/mnt/c/Users` round-trips.

**Open (need a real Windows box):**
1. Does `net.fetch(pathToFileURL('\\\\wsl.localhost\\...').toString())` resolve from Chromium's net stack? **Plan now makes `readFile`+`Response` the PRIMARY path for UNC** (Node fs handles UNC natively), so this is de-risked — but confirm the primary path performs acceptably.
2. Does Windows `git.exe` tolerate a UNC cwd at all? (Plan runs inside WSL regardless; this only matters if we ever shortcut.)
3. What does `dialog.showOpenDialog` return when browsing into `\\wsl.localhost\` — UNC or normalized? Affects whether stored bg paths are already Windows-accessible (likely yes → legacy fallback is light).
4. What does `webUtils.getPathForFile` return for a file dragged from the WSL share in Explorer (UNC vs drive)? Affects drag-drop conversion (which now uses async `wsl.toWslPath`, so tolerant either way).

## 11. Testing strategy

- **Unit (CI-safe, pure):** `path-platform.ts` helpers (`toWslUncPath`/`parseWslUncPath`/`toWindowsAccessiblePath`/`pathForPaneContext`/`toFleetImageUrl` round-trips incl. spaces, Unicode, `wsl$` vs `wsl.localhost`, `D:` drive, `/mnt/c`), and `protocol-paths.ts` (drive/UNC/POSIX/legacy shapes with a mocked distro list).
- **Verify commands:** `npm run typecheck` (node+web), `npm run lint`, `npm run build`.
- **Manual on Windows + WSL (`Ubuntu-24.04`):** (a) background image from `\\wsl.localhost\...` and from `D:\` renders + survives restart; slideshow on a WSL folder; (b) recent images shows WSL `~/Pictures` when a WSL pane is active, thumbnails render; (c) selecting/dragging an image into a WSL pane pastes a single-quoted `/home/...` or `/mnt/c/...` path that `ls` resolves; into a PowerShell pane pastes a double-quoted Windows path; (d) Git Changes works for a repo opened in a WSL pane; (e) file search/grep return WSL results; (f) `fleet open ./file` from a WSL shell opens a WSL pane at the right cwd; (g) sessions panel lists WSL Claude/Rune sessions; (h) regression: a non-WSL Windows machine and macOS behave unchanged.

## 12. Risks & sequencing

- **Phase 0 + 1 are low-risk and ship the visible win** (backgrounds, screenshots, image/pdf viewers). Do these first; they're self-contained and fix the reported symptom plus the latent Windows drive-letter bug for *all* Windows users.
- **Phase 2** is small and independent.
- **Phase 3** touches core spawn paths — gate behind per-feature `pathContext` checks; native (non-WSL) paths must be byte-for-byte unchanged.
- **Phase 4** (reverse-interop CLI re-exec + session readers) is the largest architectural change; treat as a separate milestone.
- UNC 9P perf: bound every WSL-share scan with depth + time limits; never recursive-walk the share.
- Stopped-distro: every UNC read and `wsl.exe` spawn can cold-boot the VM (multi-second) — all WSL-touching IPC needs a timeout that degrades gracefully ("not available") rather than hanging.
- Back-compat: do **not** change stored settings formats; the renderer rebuilds URLs through the new builder each render, so old stored `imagePath` values are fixed by the builder (the handler's legacy branch only covers the forward-slash drive shape).

## 13. Validated gaps to fold into the phases

From the Fable 5 adversarial review (file refs confirmed against the tree):
1. **`getActivePaneContext` is workspace-global for some consumers** — background slideshow + Sidebar thumbnails are not pane-scoped; define the fallback (active pane → active tab → host default) explicitly for those global features.
2. **Warm `wslHomeByDistro` at pane creation**, not lazily on Telescope open — Phase 2's `displayPath` switch depends on it being populated for any WSL pane (`homes-store.ts`, currently warmed only via Telescope).
3. **`joinPath` in `shell-utils.ts:22-24`** has the same `window.fleet.platform` separator bug (used by `fleet-skill-prompt.ts`); fold into the §7 sweep or deprecate in favor of `path-platform.join(ctx, …)`.
4. **`GIT_REPO_ROOT` semantics change** — after Phase 3 it returns `/home/...` for WSL panes (was garbage/null); downstream worktree/kanban flows must keep it POSIX, not re-`path.win32.join` it.
5. **Distro for bare-POSIX paths** that reach main without context: renderer should convert to Windows-accessible form *before* building URLs (distro known from pane/`homes-store`); the handler's POSIX→UNC fallback uses the **default distro** (`WslService.listDistros()` `isDefault`) explicitly — document the heuristic.
6. **`mkdtemp`/`tmpdir` audit beyond env-editor** — Phase 3 worktree/kanban dir creation (`kanban/workspace.ts:98`) must `mkdir -p` WSL-side when the repo is WSL.
