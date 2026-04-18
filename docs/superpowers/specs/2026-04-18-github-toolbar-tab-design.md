# GitHub Issues & PRs Toolbar Tab

## Goal

Add a pinned sidebar tab that lets Fleet users work with GitHub issues and pull requests for the repo behind their currently active worktree — without leaving the app.

Scope is narrow by design: view issues/PRs, read & write comments, approve or request changes on a PR, create a new PR, and read (but not edit) PR diffs. Anything deeper — inline review comments, batched reviews, merging — stays in the browser for now.

## Non-Goals

- No full GitHub parity. Inline diff comments, batched reviews, merging, branch protection config, settings, releases, and wiki are out of scope.
- No support for non-GitHub hosts (GitLab, Bitbucket).
- No notifications inbox or unread badging.
- No offline-first behavior. The panel requires network when visible; cached data is best-effort.
- No PR *editing* of diffs — read-only.

## Assumptions

- The user already has (or can create) a GitHub account capable of OAuth device-flow authentication.
- The active worktree's `origin` remote points to a GitHub repo (SSH or HTTPS). If not, the panel shows a "not a GitHub repo" empty state.
- One GitHub account per Fleet user. Multi-account switching is deferred.
- Desktop-only. No responsive/mobile layout considerations.

## Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope of repos | Current worktree's repo only | Matches Fleet's worktree-centric mental model; avoids a global repo picker. |
| Auth | OAuth device flow, token encrypted with Electron `safeStorage` to a file in `app.getPath('userData')` | Works for users without `gh` CLI; better UX than PAT paste. `safeStorage` uses the OS keychain under the hood without the native-module rebuild headache of `keytar`. |
| Panel layout | Master/detail, combined Issues + PRs list with type filter | NN/g: tabs are for alternative views of the *same* object, not for browsing separate collections. Combined list preserves the single-collection model. |
| Refresh | Poll every 60s while tab is visible | Cheap, fresh-enough, zero background-notification plumbing. |
| Diff | Read-only unified diff with syntax highlighting | 80% of value; skipping inline comments avoids GitHub's review state machine. |
| Review action | Single-click Approve / Request changes / Comment with optional body | Matches GitHub's own top-of-PR shortcut. |
| Create PR | Auto-fill head=current branch, base=default, with "change branches" escape hatch | Fast path for the common case; escape hatch for the occasional exception. |

## Architecture

### Layers

**Main process — `src/main/github/`**
- `oauth.ts` — GitHub OAuth device flow (request code, poll token endpoint, emit result).
- `tokens.ts` — `safeStorage` wrapper: `getToken()`, `setToken(token)`, `deleteToken()`. Encrypted blob lives at `path.join(app.getPath('userData'), 'github-token.enc')`.
- `client.ts` — returns an authenticated Octokit instance. Wraps each call with rate-limit header extraction.
- `repo.ts` — `detectRepoFromWorktree(path) → { owner, name } | null`. Reads `.git/config` of the worktree, parses `origin` URL, returns owner/name. Supports SSH (`git@github.com:owner/name.git`) and HTTPS (`https://github.com/owner/name`). Returns `null` for non-GitHub remotes or missing origin.
- `service.ts` — thin domain wrapper: `listItems(owner, name)`, `getIssue(owner, name, number)`, `getPR(owner, name, number)`, `getPRFiles(owner, name, number)`, `getChecks(owner, name, sha)`, `createComment(...)`, `createReview(...)`, `createPR(...)`, `listBranches(owner, name)`.
- `ipc.ts` — IPC handlers. Each validates args with zod, loads token, surfaces rate-limit info in every response envelope.

**Preload — `src/preload/index.ts`**
- Extend `window.fleet.github.*`: `signIn()`, `signOut()`, `getAuthState()`, `onAuthChanged(cb)`, `listItems`, `getIssue`, `getPR`, `getPRFiles`, `getChecks`, `createComment`, `createReview`, `createPR`, `listBranches`, `detectRepo(path)`.

**Renderer — `src/renderer/src/`**
- `store/github-store.ts` — Zustand store. Holds auth state, active repo, per-repo list cache, per-item detail cache, selected id, filter state, polling handle, rate-limit state.
- `components/github/` — all renderer components listed below.

### State subscription topology

- Workspace store → track `activeTabId` and `tabs[activeTabId].cwd` when the active tab is non-pinned and has a cwd.
- GitHub store → subscribes to that slice; when it changes, calls `detectRepo(cwd)` and updates `activeRepo`.
- When `activeRepo` changes **and** the GitHub tab is visible, fire a list refresh.

This way, switching worktrees updates the "tracked repo" even while the GitHub tab is hidden; opening the tab simply triggers a refresh of whatever is tracked.

## Components

**Top-level**
- `GitHubTab.tsx` — auth gate → sign-in screen OR main layout (header + master + detail).

**Auth**
- `GitHubSignInScreen.tsx` — device-flow UI: show user code, "Open browser" button (calls `shell.openExternal(verificationUri)`), poll-in-progress indicator, expired/retry state.

**Layout**
- `GitHubRepoHeader.tsx` — `owner/repo` link, refresh button, last-refreshed timestamp, "New PR" button, overflow menu (sign out).
- `GitHubList.tsx` — filter chip row (All / Issues / PRs / Mine), search input, virtualized scrollable list.
- `GitHubListItem.tsx` — icon (state-specific), title, `#number`, author avatar, relative age, label pills, comment count, CI status dot (PRs only).
- `GitHubDetailPane.tsx` — empty state when nothing selected; routes to `IssueDetail` or `PRDetail`.

**Detail**
- `IssueDetail.tsx` — title, state badge, labels/assignees strip, body, comment thread, `CommentComposer`.
- `PRDetail.tsx` — same as `IssueDetail` plus review action bar (Approve / Request changes / Comment), sub-tabs for Conversation | Files | Checks.
- `PRFilesView.tsx` — file list (left) + diff view (right, `react-diff-viewer-continued` or equivalent). Files with > 2000 changed lines show a "too large — open on GitHub" link.
- `PRChecksView.tsx` — list of checks with status icons.
- `NewPRDialog.tsx` — Radix Dialog. Auto-fills head/base/title; "change branches" toggle reveals branch dropdowns populated from `listBranches`.

**Shared**
- `MarkdownBody.tsx` — `react-markdown` + `remark-gfm` + syntax highlighting. Sanitized (no raw HTML).
- `CommentComposer.tsx` — textarea with Write/Preview toggle, Submit button, disabled during submit.

## Data Flow

**Sign-in**
1. User opens tab → no token → `GitHubSignInScreen`.
2. Click "Sign in" → `window.fleet.github.signIn()` → main starts device flow.
3. Main returns `{ userCode, verificationUri, expiresIn }` to renderer.
4. Renderer displays code and opens `verificationUri` via `shell.openExternal`.
5. Main polls GitHub's token endpoint per OAuth spec.
6. On success → store token in keychain, emit `github:auth-changed`.
7. Renderer flips to authenticated state.
8. On expiry or denial → renderer shows retry screen.

**Active repo tracking**
1. Renderer subscribes to workspace-store `activeTabId`. When active tab is non-pinned with a `cwd`, call `detectRepo(cwd)` → `{ owner, name } | null`.
2. `activeRepo` stored in github-store. Switching to the GitHub tab does not change which repo is tracked — the tracked repo is whatever the last non-pinned tab dictated.
3. If `activeRepo === null` → panel shows "Open a worktree to see its issues and PRs".

**List fetch + polling**
1. On (visible AND activeRepo changed) OR (visible AND last-refreshed > 60s ago) → fire `listItems(owner, name)`.
2. `listItems` issues parallel `issues.listForRepo` + `pulls.list`, merged and sorted by `updated_at` desc.
3. Result cached in `repos[owner/name]` with timestamp.
4. 60s interval schedules re-fetch while visible.
5. Interval cleared on visibility change to hidden or unmount.
6. Manual refresh cancels pending interval and re-fires.

**Item selection**
1. Click list item → store sets `selectedId`.
2. Detail pane fires `getIssue` or `getPR` → caches full body + comments by id.
3. For PRs, `getPRFiles` and `getChecks` fire lazily when their sub-tabs are first opened.
4. Detail cache stale after 60s or explicit refresh.

**Writes (comment / review / create-PR)**
1. Optimistic: append pending entry to local cache with `pending: true`.
2. IPC to main → Octokit call.
3. Success → replace pending entry with server response.
4. Failure → remove pending entry, toast with error + "Retry". Form state preserved so user doesn't lose text.

**Rate-limit awareness**
- Every IPC response includes `{ data, rateLimit: { remaining, resetAt } }`.
- When `remaining < 100` → warning strip in header.
- When `remaining === 0` → polling disabled, writes disabled, strip shows reset time.

## Error Handling

| Condition | Behavior |
|---|---|
| No `origin` remote / non-GitHub remote | "Not a GitHub repo" empty state. No API calls. |
| Token expired/revoked (401) | Clear token, show sign-in screen, preserve last-selected repo. |
| Network offline | Toast "Offline — will retry". Pause polling. Resume on `navigator.onLine`. |
| Rate limit (403 + ratelimit headers) | Warning strip with reset time. Disable polling + writes. List still usable from cache. |
| Write failure | Roll back optimistic entry. Toast with error + "Retry". Form contents preserved. |
| OAuth device-flow timeout | Sign-in screen shows "Code expired" + retry button. |
| 404/403 on a previously-accessible repo | Per-repo empty state "No access to this repo" + sign-out link. |
| Huge diff (> 2000 lines in one file) | "File too large — open on GitHub" link. |
| Raw HTML in markdown | Sanitized by `react-markdown` default — rendered as text. |

## Testing

**Unit (Vitest)**
- `detectRepoFromWorktree` — SSH, HTTPS, mixed-case, missing origin, non-GitHub.
- `github-store` — selector behavior, optimistic add/rollback, polling start/stop on visibility changes, cache keying.
- IPC handlers — zod validation, rejection on missing token, rate-limit envelope shape.

**Integration (Vitest + msw)**
- Mock GitHub REST. Cover: pagination, PR files, review create, rate-limit headers, 401 flow.
- Mock token endpoint for device flow: pending → success, pending → expired.

**Renderer component tests (Vitest + Testing Library)**
- `GitHubList` — filter chips + search interaction.
- `PRDetail` — sub-tab switching + lazy fetch of Files/Checks.
- `NewPRDialog` — "change branches" toggle, field validation.

**Manual smoke (release checklist)**
- Sign in (verify encrypted token round-trips on macOS).
- Open a worktree, refresh list, open a PR.
- Leave a comment, approve, request changes.
- Create a new PR from a branch (default auto-fill and explicit branch override).
- Switch worktrees while panel is visible — list updates.
- Revoke token in GitHub settings → next API call flips panel to sign-in.

## Files to Create

- `src/main/github/oauth.ts`
- `src/main/github/tokens.ts`
- `src/main/github/client.ts`
- `src/main/github/repo.ts`
- `src/main/github/service.ts`
- `src/main/github/ipc.ts`
- `src/renderer/src/store/github-store.ts`
- `src/renderer/src/components/github/GitHubTab.tsx`
- `src/renderer/src/components/github/GitHubSignInScreen.tsx`
- `src/renderer/src/components/github/GitHubRepoHeader.tsx`
- `src/renderer/src/components/github/GitHubList.tsx`
- `src/renderer/src/components/github/GitHubListItem.tsx`
- `src/renderer/src/components/github/GitHubDetailPane.tsx`
- `src/renderer/src/components/github/IssueDetail.tsx`
- `src/renderer/src/components/github/PRDetail.tsx`
- `src/renderer/src/components/github/PRFilesView.tsx`
- `src/renderer/src/components/github/PRChecksView.tsx`
- `src/renderer/src/components/github/NewPRDialog.tsx`
- `src/renderer/src/components/github/MarkdownBody.tsx`
- `src/renderer/src/components/github/CommentComposer.tsx`

## Files to Modify

- `src/shared/types.ts` — add `'github'` to `Tab['type']` union.
- `src/renderer/src/App.tsx` — add `tab.type === 'github'` case rendering `<GitHubTab />`.
- `src/renderer/src/components/Sidebar.tsx` — add `GitHubTabCard` alongside `ImagesTabCard` / `AnnotateTabCard`.
- `src/renderer/src/store/workspace-store.ts` — add `ensureGitHubTab()` pinned-tab bootstrapper.
- `src/preload/index.ts` — expose `window.fleet.github.*` API.
- `src/main/index.ts` — register GitHub IPC handlers on app ready.
- `package.json` — add `@octokit/rest`, `react-markdown`, `remark-gfm`, `react-diff-viewer-continued` (or equivalent). No new native modules — `safeStorage` is built into Electron.

## Open Questions (for implementation-planning, not blocking spec approval)

- Exact diff viewer library choice (`react-diff-viewer-continued` vs `diff2html` vs custom) — defer to implementation-planning based on bundle size and syntax-highlighting quality.
- Where does the GitHub OAuth client ID live? Hardcoded in main process is the standard pattern for OAuth apps; confirm no rotation story is needed for Fleet releases.
- Behavior when `safeStorage.isEncryptionAvailable()` returns `false` (headless Linux, certain CI environments) — acceptable fallback: refuse to persist the token and require sign-in each session. Confirm this is fine for Fleet's supported platforms.
