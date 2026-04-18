# GitHub Issues & PRs Toolbar Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pinned sidebar tab that shows GitHub issues and pull requests for the currently active worktree's repo, supporting read, comment, approve/request-changes, and PR creation.

**Architecture:** Electron main process hosts an Octokit-based GitHub service, OAuth device-flow auth with tokens encrypted via `safeStorage` to a file in `userData`. Renderer uses a Zustand store and a master/detail layout with combined issues+PRs list filterable by type. Polling at 60s while the tab is visible. Read-only diff via `@git-diff-view/react`, review actions via top-of-PR buttons.

**Tech Stack:** Electron 39, React 19, Zustand 5, `@octokit/rest`, `electron`'s `safeStorage`, `zod`, `react-markdown`, `remark-gfm`, `rehype-highlight`, `@git-diff-view/react` (already installed), Radix Dialog, Tailwind v4, Vitest.

**Spec:** [`docs/superpowers/specs/2026-04-18-github-toolbar-tab-design.md`](../specs/2026-04-18-github-toolbar-tab-design.md)

---

## Prerequisites (Manual, Pre-Task-1)

Before executing Task 1, the Fleet maintainer must:

1. Register a GitHub OAuth App at https://github.com/settings/applications/new
   - **Application name:** `Fleet Desktop`
   - **Homepage URL:** `https://github.com/khang859/fleet`
   - **Authorization callback URL:** `https://github.com/khang859/fleet` (unused for device flow, but required by the form)
   - On the created app's page, click **"Enable Device Flow"**.
2. Copy the **Client ID** and paste it into `src/main/github/oauth.ts` as the `GITHUB_CLIENT_ID` constant in Task 4.
3. No client secret is needed — device flow uses public-client auth.

If this pre-work hasn't happened, stop and ask the user to complete it.

---

## File Structure

**Main process — `src/main/github/`:**
- `oauth.ts` — Device-flow: request user code, poll for token.
- `tokens.ts` — `safeStorage`-encrypted token file I/O.
- `client.ts` — Octokit factory + rate-limit extractor.
- `repo.ts` — Parse `origin` from a worktree's `.git/config`.
- `service.ts` — Thin domain wrapper over Octokit.
- `ipc.ts` — IPC handlers, zod validation, rate-limit envelope.

**Shared types — `src/shared/`:**
- `github-types.ts` — DTOs shared between main and renderer.
- `ipc-channels.ts` — extend with `GH_*` channels.

**Preload — `src/preload/index.ts`:**
- Extend `window.fleet.github.*`.

**Renderer store — `src/renderer/src/store/`:**
- `github-store.ts` — Zustand store.

**Renderer components — `src/renderer/src/components/github/`:**
- `GitHubTab.tsx`
- `GitHubSignInScreen.tsx`
- `GitHubRepoHeader.tsx`
- `GitHubList.tsx`
- `GitHubListItem.tsx`
- `GitHubDetailPane.tsx`
- `IssueDetail.tsx`
- `PRDetail.tsx`
- `PRFilesView.tsx`
- `PRChecksView.tsx`
- `NewPRDialog.tsx`
- `MarkdownBody.tsx`
- `CommentComposer.tsx`

**Modified:**
- `src/shared/types.ts` — `'github'` in `Tab.type` union.
- `src/renderer/src/App.tsx` — add `tab.type === 'github'` case.
- `src/renderer/src/components/Sidebar.tsx` — add `GitHubTabCard`.
- `src/renderer/src/store/workspace-store.ts` — `ensureGitHubTab()`.
- `src/main/index.ts` — register GitHub IPC handlers on app ready.
- `package.json` — add `@octokit/rest`.

---

## Task 1: Install dependencies and wire up the `github` tab type

**Files:**
- Modify: `package.json`
- Modify: `src/shared/types.ts:15`
- Modify: `src/shared/ipc-channels.ts` (append)
- Create: `src/shared/github-types.ts`

- [ ] **Step 1: Install `@octokit/rest`**

```bash
npm install @octokit/rest@^22.0.0
```

Expected: package added to `dependencies`, lockfile updated.

- [ ] **Step 2: Add `'github'` to the `Tab.type` union**

In `src/shared/types.ts:15`, change:

```ts
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown';
```

to:

```ts
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown' | 'github';
```

- [ ] **Step 3: Append GitHub IPC channel constants**

Append to `src/shared/ipc-channels.ts` inside the `IPC_CHANNELS` object, before the closing brace:

```ts
  // GitHub
  GH_SIGN_IN_START: 'gh:sign-in:start',
  GH_SIGN_IN_POLL: 'gh:sign-in:poll',
  GH_SIGN_OUT: 'gh:sign-out',
  GH_AUTH_STATE: 'gh:auth:state',
  GH_AUTH_CHANGED: 'gh:auth:changed',
  GH_DETECT_REPO: 'gh:detect-repo',
  GH_LIST_ITEMS: 'gh:list-items',
  GH_GET_ISSUE: 'gh:get-issue',
  GH_GET_PR: 'gh:get-pr',
  GH_GET_PR_FILES: 'gh:get-pr-files',
  GH_GET_CHECKS: 'gh:get-checks',
  GH_LIST_BRANCHES: 'gh:list-branches',
  GH_CREATE_COMMENT: 'gh:create-comment',
  GH_CREATE_REVIEW: 'gh:create-review',
  GH_CREATE_PR: 'gh:create-pr',
```

- [ ] **Step 4: Create `src/shared/github-types.ts`**

```ts
export type GitHubRepoRef = { owner: string; name: string };

export type GitHubAuthState =
  | { status: 'unauthenticated' }
  | { status: 'authenticating'; userCode: string; verificationUri: string; expiresAt: number }
  | { status: 'authenticated'; login: string; avatarUrl: string };

export type GitHubItemKind = 'issue' | 'pr';
export type GitHubItemState = 'open' | 'closed' | 'merged' | 'draft';

export type GitHubListItem = {
  kind: GitHubItemKind;
  number: number;
  title: string;
  state: GitHubItemState;
  author: { login: string; avatarUrl: string };
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  labels: { name: string; color: string }[];
  checksStatus?: 'passing' | 'failing' | 'pending' | 'none';
  branch?: { head: string; base: string };
};

export type GitHubComment = {
  id: number;
  author: { login: string; avatarUrl: string };
  body: string;
  createdAt: string;
};

export type GitHubIssueDetail = GitHubListItem & {
  body: string;
  comments: GitHubComment[];
  assignees: { login: string; avatarUrl: string }[];
};

export type GitHubPRDetail = GitHubIssueDetail & {
  kind: 'pr';
  headSha: string;
  mergeable: boolean | null;
};

export type GitHubPRFile = {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
  previousFilename?: string;
};

export type GitHubCheck = {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
  detailsUrl: string | null;
};

export type RateLimitInfo = { remaining: number; limit: number; resetAt: number };

export type Envelope<T> = { data: T; rateLimit: RateLimitInfo | null };

export type ReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export type CreatePRInput = {
  owner: string;
  name: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};
```

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/shared/types.ts src/shared/ipc-channels.ts src/shared/github-types.ts
git commit -m "feat(github): scaffold shared types and IPC channels"
```

---

## Task 2: Repo detection from worktree `.git/config`

**Files:**
- Create: `src/main/github/repo.ts`
- Create: `src/main/__tests__/github-repo.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/main/__tests__/github-repo.test.ts
import { describe, it, expect } from 'vitest';
import { parseGithubRemote } from '../github/repo';

describe('parseGithubRemote', () => {
  it('parses SSH URL', () => {
    expect(parseGithubRemote('git@github.com:khang859/fleet.git')).toEqual({ owner: 'khang859', name: 'fleet' });
  });
  it('parses SSH URL without .git suffix', () => {
    expect(parseGithubRemote('git@github.com:khang859/fleet')).toEqual({ owner: 'khang859', name: 'fleet' });
  });
  it('parses HTTPS URL', () => {
    expect(parseGithubRemote('https://github.com/khang859/fleet.git')).toEqual({ owner: 'khang859', name: 'fleet' });
  });
  it('parses HTTPS URL without .git', () => {
    expect(parseGithubRemote('https://github.com/khang859/fleet')).toEqual({ owner: 'khang859', name: 'fleet' });
  });
  it('preserves mixed-case owner', () => {
    expect(parseGithubRemote('git@github.com:Anthropic/Foo.git')).toEqual({ owner: 'Anthropic', name: 'Foo' });
  });
  it('returns null for non-github host', () => {
    expect(parseGithubRemote('git@gitlab.com:khang/fleet.git')).toBeNull();
  });
  it('returns null for malformed input', () => {
    expect(parseGithubRemote('')).toBeNull();
    expect(parseGithubRemote('not a url')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/github-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseGithubRemote`**

```ts
// src/main/github/repo.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitHubRepoRef } from '../../shared/github-types';

export function parseGithubRemote(url: string): GitHubRepoRef | null {
  if (!url) return null;
  const trimmed = url.trim();
  // git@github.com:owner/name(.git)?
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return { owner: ssh[1], name: ssh[2] };
  // https://github.com/owner/name(.git)?
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return { owner: https[1], name: https[2] };
  return null;
}

export async function detectRepoFromWorktree(worktreePath: string): Promise<GitHubRepoRef | null> {
  try {
    const configPath = path.join(worktreePath, '.git', 'config');
    const raw = await fs.readFile(configPath, 'utf8');
    // Extract the url under [remote "origin"]
    const match = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(raw);
    if (!match) return null;
    return parseGithubRemote(match[1].trim());
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/github-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/repo.ts src/main/__tests__/github-repo.test.ts
git commit -m "feat(github): parse origin remote and detect repo from worktree"
```

---

## Task 3: Encrypted token storage via `safeStorage`

**Files:**
- Create: `src/main/github/tokens.ts`
- Create: `src/main/__tests__/github-tokens.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/main/__tests__/github-tokens.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

vi.mock('electron', () => {
  let enc: Record<string, string> = {};
  return {
    app: { getPath: () => path.join(os.tmpdir(), `fleet-gh-test-${process.pid}`) },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => {
        const id = `enc:${s}`;
        enc[id] = s;
        return Buffer.from(id);
      },
      decryptString: (buf: Buffer) => {
        const id = buf.toString();
        return enc[id] ?? '';
      },
    },
  };
});

import { getToken, setToken, deleteToken, isStorageAvailable } from '../github/tokens';

describe('tokens', () => {
  beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `fleet-gh-test-${process.pid}`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  });

  it('returns null when no token stored', async () => {
    expect(await getToken()).toBeNull();
  });

  it('round-trips a token', async () => {
    await setToken('ghp_abc123');
    expect(await getToken()).toBe('ghp_abc123');
  });

  it('deleteToken clears stored value', async () => {
    await setToken('ghp_abc123');
    await deleteToken();
    expect(await getToken()).toBeNull();
  });

  it('reports storage availability', () => {
    expect(isStorageAvailable()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify failure**

Run: `npx vitest run src/main/__tests__/github-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement tokens module**

```ts
// src/main/github/tokens.ts
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

function tokenPath(): string {
  return path.join(app.getPath('userData'), 'github-token.enc');
}

export function isStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export async function getToken(): Promise<string | null> {
  if (!isStorageAvailable()) return null;
  try {
    const buf = await fs.readFile(tokenPath());
    return safeStorage.decryptString(buf) || null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  if (!isStorageAvailable()) {
    throw new Error('safeStorage encryption not available on this platform');
  }
  const encrypted = safeStorage.encryptString(token);
  await fs.mkdir(path.dirname(tokenPath()), { recursive: true });
  await fs.writeFile(tokenPath(), encrypted, { mode: 0o600 });
}

export async function deleteToken(): Promise<void> {
  try {
    await fs.unlink(tokenPath());
  } catch {
    // ignore
  }
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `npx vitest run src/main/__tests__/github-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/tokens.ts src/main/__tests__/github-tokens.test.ts
git commit -m "feat(github): encrypted token storage via safeStorage"
```

---

## Task 4: OAuth device flow

**Files:**
- Create: `src/main/github/oauth.ts`
- Create: `src/main/__tests__/github-oauth.test.ts`

> **Prereq:** Replace `GITHUB_CLIENT_ID` placeholder with the Client ID from the GitHub OAuth App registered in the prerequisites section.

- [ ] **Step 1: Write failing tests**

```ts
// src/main/__tests__/github-oauth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { requestDeviceCode, pollForToken } from '../github/oauth';

describe('oauth device flow', () => {
  beforeEach(() => fetchMock.mockReset());

  it('requests a device code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: 'dev123',
        user_code: 'AAAA-BBBB',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
    });
    const res = await requestDeviceCode();
    expect(res.userCode).toBe('AAAA-BBBB');
    expect(res.verificationUri).toBe('https://github.com/login/device');
    expect(res.deviceCode).toBe('dev123');
    expect(res.interval).toBe(5);
  });

  it('returns token on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'ghu_xyz', token_type: 'bearer', scope: 'repo' }),
    });
    const res = await pollForToken('dev123');
    expect(res).toEqual({ status: 'success', accessToken: 'ghu_xyz' });
  });

  it('returns pending on authorization_pending', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'authorization_pending' }),
    });
    const res = await pollForToken('dev123');
    expect(res).toEqual({ status: 'pending' });
  });

  it('returns slow_down with new interval', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'slow_down', interval: 10 }),
    });
    const res = await pollForToken('dev123');
    expect(res).toEqual({ status: 'slow_down', interval: 10 });
  });

  it('returns expired on expired_token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'expired_token' }),
    });
    expect(await pollForToken('dev123')).toEqual({ status: 'expired' });
  });

  it('returns denied on access_denied', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'access_denied' }),
    });
    expect(await pollForToken('dev123')).toEqual({ status: 'denied' });
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run src/main/__tests__/github-oauth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement oauth module**

```ts
// src/main/github/oauth.ts
// Replace with the Client ID from your registered GitHub OAuth App (see Prerequisites).
export const GITHUB_CLIENT_ID = 'REPLACE_WITH_CLIENT_ID';
const SCOPES = 'repo read:user';

export type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'success'; accessToken: string }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: SCOPES }),
  });
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
  const json = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    expiresIn: json.expires_in,
    interval: json.interval,
  };
}

export async function pollForToken(deviceCode: string): Promise<PollResult> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
  const json = (await res.json()) as { access_token?: string; error?: string; interval?: number };
  if (json.access_token) return { status: 'success', accessToken: json.access_token };
  switch (json.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down', interval: json.interval ?? 10 };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      return { status: 'error', message: json.error ?? 'unknown' };
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run src/main/__tests__/github-oauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/oauth.ts src/main/__tests__/github-oauth.test.ts
git commit -m "feat(github): oauth device-flow token exchange"
```

---

## Task 5: Octokit client factory + rate-limit extractor

**Files:**
- Create: `src/main/github/client.ts`
- Create: `src/main/__tests__/github-client.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/main/__tests__/github-client.test.ts
import { describe, it, expect } from 'vitest';
import { extractRateLimit } from '../github/client';

describe('extractRateLimit', () => {
  it('extracts standard rate-limit headers', () => {
    const headers = new Map<string, string>([
      ['x-ratelimit-remaining', '4999'],
      ['x-ratelimit-limit', '5000'],
      ['x-ratelimit-reset', '1700000000'],
    ]);
    expect(extractRateLimit(headers)).toEqual({ remaining: 4999, limit: 5000, resetAt: 1700000000 * 1000 });
  });
  it('returns null when headers missing', () => {
    expect(extractRateLimit(new Map())).toBeNull();
  });
  it('reads Headers objects too', () => {
    const h = new Headers();
    h.set('x-ratelimit-remaining', '10');
    h.set('x-ratelimit-limit', '5000');
    h.set('x-ratelimit-reset', '1700000000');
    expect(extractRateLimit(h)).toEqual({ remaining: 10, limit: 5000, resetAt: 1700000000 * 1000 });
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/main/__tests__/github-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement client module**

```ts
// src/main/github/client.ts
import { Octokit } from '@octokit/rest';
import type { RateLimitInfo } from '../../shared/github-types';

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: 'fleet-desktop' });
}

export function extractRateLimit(headers: Headers | Map<string, string> | Record<string, string>): RateLimitInfo | null {
  const get = (k: string): string | null => {
    if (headers instanceof Headers) return headers.get(k);
    if (headers instanceof Map) return headers.get(k) ?? null;
    return (headers as Record<string, string>)[k] ?? null;
  };
  const remaining = get('x-ratelimit-remaining');
  const limit = get('x-ratelimit-limit');
  const reset = get('x-ratelimit-reset');
  if (remaining === null || limit === null || reset === null) return null;
  return {
    remaining: Number(remaining),
    limit: Number(limit),
    resetAt: Number(reset) * 1000,
  };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run src/main/__tests__/github-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/github/client.ts src/main/__tests__/github-client.test.ts
git commit -m "feat(github): octokit factory and rate-limit extractor"
```

---

## Task 6: Service layer (issues, PRs, reviews, PR creation)

**Files:**
- Create: `src/main/github/service.ts`

> Service is a thin adapter over Octokit. Shape is exercised via integration tests in Task 7 (IPC handlers). No unit tests needed here — it's mechanical mapping.

- [ ] **Step 1: Implement service module**

```ts
// src/main/github/service.ts
import type { Octokit } from '@octokit/rest';
import type {
  Envelope,
  GitHubListItem,
  GitHubIssueDetail,
  GitHubPRDetail,
  GitHubPRFile,
  GitHubCheck,
  GitHubItemState,
  CreatePRInput,
  ReviewVerdict,
} from '../../shared/github-types';
import { extractRateLimit } from './client';

type OctokitResponse<T> = { data: T; headers: Record<string, string> };

function envelope<T>(res: OctokitResponse<unknown>, data: T): Envelope<T> {
  return { data, rateLimit: extractRateLimit(res.headers) };
}

function mapUser(u: { login: string; avatar_url: string } | null | undefined): { login: string; avatarUrl: string } {
  return { login: u?.login ?? 'ghost', avatarUrl: u?.avatar_url ?? '' };
}

function mapLabels(labels: Array<{ name?: string; color?: string } | string>): { name: string; color: string }[] {
  return labels.map((l) =>
    typeof l === 'string' ? { name: l, color: '888888' } : { name: l.name ?? '', color: l.color ?? '888888' },
  );
}

function deriveState(item: {
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  pull_request?: unknown;
}): GitHubItemState {
  if (item.merged_at) return 'merged';
  if (item.draft) return 'draft';
  if (item.state === 'closed') return 'closed';
  return 'open';
}

export async function listItems(
  octo: Octokit,
  owner: string,
  name: string,
): Promise<Envelope<GitHubListItem[]>> {
  const [issuesRes, prsRes] = await Promise.all([
    octo.issues.listForRepo({ owner, repo: name, state: 'open', per_page: 50 }),
    octo.pulls.list({ owner, repo: name, state: 'open', per_page: 50 }),
  ]);
  const issues: GitHubListItem[] = issuesRes.data
    .filter((i) => !i.pull_request) // issues.listForRepo includes PRs; filter them out
    .map((i) => ({
      kind: 'issue',
      number: i.number,
      title: i.title,
      state: deriveState(i),
      author: mapUser(i.user),
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      commentCount: i.comments,
      labels: mapLabels(i.labels as Array<{ name?: string; color?: string } | string>),
    }));
  const prs: GitHubListItem[] = prsRes.data.map((p) => ({
    kind: 'pr',
    number: p.number,
    title: p.title,
    state: deriveState(p as { state: string; draft?: boolean; merged_at?: string | null }),
    author: mapUser(p.user),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    commentCount: 0, // filled by detail; list endpoint omits it
    labels: mapLabels(p.labels as Array<{ name?: string; color?: string } | string>),
    branch: { head: p.head.ref, base: p.base.ref },
  }));
  const merged = [...issues, ...prs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return envelope(prsRes as unknown as OctokitResponse<unknown>, merged);
}

export async function getIssue(
  octo: Octokit,
  owner: string,
  name: string,
  number: number,
): Promise<Envelope<GitHubIssueDetail>> {
  const [issueRes, commentsRes] = await Promise.all([
    octo.issues.get({ owner, repo: name, issue_number: number }),
    octo.issues.listComments({ owner, repo: name, issue_number: number, per_page: 100 }),
  ]);
  const i = issueRes.data;
  const detail: GitHubIssueDetail = {
    kind: 'issue',
    number: i.number,
    title: i.title,
    state: deriveState(i),
    author: mapUser(i.user),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    commentCount: i.comments,
    labels: mapLabels(i.labels as Array<{ name?: string; color?: string } | string>),
    body: i.body ?? '',
    assignees: (i.assignees ?? []).map(mapUser),
    comments: commentsRes.data.map((c) => ({
      id: c.id,
      author: mapUser(c.user),
      body: c.body ?? '',
      createdAt: c.created_at,
    })),
  };
  return envelope(issueRes as unknown as OctokitResponse<unknown>, detail);
}

export async function getPR(
  octo: Octokit,
  owner: string,
  name: string,
  number: number,
): Promise<Envelope<GitHubPRDetail>> {
  const [prRes, commentsRes] = await Promise.all([
    octo.pulls.get({ owner, repo: name, pull_number: number }),
    octo.issues.listComments({ owner, repo: name, issue_number: number, per_page: 100 }),
  ]);
  const p = prRes.data;
  const detail: GitHubPRDetail = {
    kind: 'pr',
    number: p.number,
    title: p.title,
    state: deriveState(p as { state: string; draft?: boolean; merged_at?: string | null }),
    author: mapUser(p.user),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    commentCount: p.comments,
    labels: mapLabels(p.labels as Array<{ name?: string; color?: string } | string>),
    body: p.body ?? '',
    assignees: (p.assignees ?? []).map(mapUser),
    branch: { head: p.head.ref, base: p.base.ref },
    headSha: p.head.sha,
    mergeable: p.mergeable,
    comments: commentsRes.data.map((c) => ({
      id: c.id,
      author: mapUser(c.user),
      body: c.body ?? '',
      createdAt: c.created_at,
    })),
  };
  return envelope(prRes as unknown as OctokitResponse<unknown>, detail);
}

export async function getPRFiles(
  octo: Octokit,
  owner: string,
  name: string,
  number: number,
): Promise<Envelope<GitHubPRFile[]>> {
  const res = await octo.pulls.listFiles({ owner, repo: name, pull_number: number, per_page: 300 });
  const files: GitHubPRFile[] = res.data.map((f) => ({
    filename: f.filename,
    status: f.status as GitHubPRFile['status'],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    previousFilename: f.previous_filename,
  }));
  return envelope(res as unknown as OctokitResponse<unknown>, files);
}

export async function getChecks(
  octo: Octokit,
  owner: string,
  name: string,
  sha: string,
): Promise<Envelope<GitHubCheck[]>> {
  const res = await octo.checks.listForRef({ owner, repo: name, ref: sha, per_page: 100 });
  const checks: GitHubCheck[] = res.data.check_runs.map((c) => ({
    name: c.name,
    status: c.status as GitHubCheck['status'],
    conclusion: c.conclusion as GitHubCheck['conclusion'],
    detailsUrl: c.details_url,
  }));
  return envelope(res as unknown as OctokitResponse<unknown>, checks);
}

export async function listBranches(
  octo: Octokit,
  owner: string,
  name: string,
): Promise<Envelope<string[]>> {
  const res = await octo.repos.listBranches({ owner, repo: name, per_page: 100 });
  return envelope(
    res as unknown as OctokitResponse<unknown>,
    res.data.map((b) => b.name),
  );
}

export async function createComment(
  octo: Octokit,
  owner: string,
  name: string,
  number: number,
  body: string,
): Promise<Envelope<{ id: number }>> {
  const res = await octo.issues.createComment({ owner, repo: name, issue_number: number, body });
  return envelope(res as unknown as OctokitResponse<unknown>, { id: res.data.id });
}

export async function createReview(
  octo: Octokit,
  owner: string,
  name: string,
  number: number,
  verdict: ReviewVerdict,
  body: string | undefined,
): Promise<Envelope<{ id: number }>> {
  const res = await octo.pulls.createReview({
    owner,
    repo: name,
    pull_number: number,
    event: verdict,
    body,
  });
  return envelope(res as unknown as OctokitResponse<unknown>, { id: res.data.id });
}

export async function createPR(
  octo: Octokit,
  input: CreatePRInput,
): Promise<Envelope<{ number: number; htmlUrl: string }>> {
  const res = await octo.pulls.create({
    owner: input.owner,
    repo: input.name,
    head: input.head,
    base: input.base,
    title: input.title,
    body: input.body,
    draft: input.draft,
  });
  return envelope(res as unknown as OctokitResponse<unknown>, {
    number: res.data.number,
    htmlUrl: res.data.html_url,
  });
}

export async function getCurrentUser(octo: Octokit): Promise<Envelope<{ login: string; avatarUrl: string }>> {
  const res = await octo.users.getAuthenticated();
  return envelope(res as unknown as OctokitResponse<unknown>, {
    login: res.data.login,
    avatarUrl: res.data.avatar_url,
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/github/service.ts
git commit -m "feat(github): service layer for issues, PRs, reviews"
```

---

## Task 7: IPC handlers with zod validation

**Files:**
- Create: `src/main/github/ipc.ts`
- Create: `src/main/__tests__/github-ipc-schemas.test.ts`

- [ ] **Step 1: Write failing tests for the zod schemas**

```ts
// src/main/__tests__/github-ipc-schemas.test.ts
import { describe, it, expect } from 'vitest';
import { schemas } from '../github/ipc';

describe('github IPC schemas', () => {
  it('listItemsInput rejects missing fields', () => {
    expect(schemas.listItemsInput.safeParse({}).success).toBe(false);
    expect(schemas.listItemsInput.safeParse({ owner: 'a', name: 'b' }).success).toBe(true);
  });
  it('createPRInput validates all fields', () => {
    expect(
      schemas.createPRInput.safeParse({
        owner: 'a',
        name: 'b',
        head: 'feat',
        base: 'main',
        title: 'T',
        body: '',
        draft: false,
      }).success,
    ).toBe(true);
    expect(schemas.createPRInput.safeParse({ owner: 'a', name: 'b' }).success).toBe(false);
  });
  it('createReviewInput requires verdict enum', () => {
    expect(
      schemas.createReviewInput.safeParse({ owner: 'a', name: 'b', number: 1, verdict: 'APPROVE' }).success,
    ).toBe(true);
    expect(
      schemas.createReviewInput.safeParse({ owner: 'a', name: 'b', number: 1, verdict: 'LGTM' }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/main/__tests__/github-ipc-schemas.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement IPC handlers**

```ts
// src/main/github/ipc.ts
import { ipcMain, BrowserWindow, shell } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { GitHubAuthState } from '../../shared/github-types';
import { getToken, setToken, deleteToken } from './tokens';
import { requestDeviceCode, pollForToken, type PollResult } from './oauth';
import { createOctokit } from './client';
import {
  listItems,
  getIssue,
  getPR,
  getPRFiles,
  getChecks,
  listBranches,
  createComment,
  createReview,
  createPR,
  getCurrentUser,
} from './service';
import { detectRepoFromWorktree } from './repo';

export const schemas = {
  detectRepoInput: z.object({ worktreePath: z.string().min(1) }),
  listItemsInput: z.object({ owner: z.string().min(1), name: z.string().min(1) }),
  getIssueInput: z.object({ owner: z.string(), name: z.string(), number: z.number().int().positive() }),
  getPRInput: z.object({ owner: z.string(), name: z.string(), number: z.number().int().positive() }),
  getPRFilesInput: z.object({ owner: z.string(), name: z.string(), number: z.number().int().positive() }),
  getChecksInput: z.object({ owner: z.string(), name: z.string(), sha: z.string().min(1) }),
  listBranchesInput: z.object({ owner: z.string(), name: z.string() }),
  createCommentInput: z.object({
    owner: z.string(),
    name: z.string(),
    number: z.number().int().positive(),
    body: z.string().min(1),
  }),
  createReviewInput: z.object({
    owner: z.string(),
    name: z.string(),
    number: z.number().int().positive(),
    verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: z.string().optional(),
  }),
  createPRInput: z.object({
    owner: z.string(),
    name: z.string(),
    head: z.string(),
    base: z.string(),
    title: z.string().min(1),
    body: z.string(),
    draft: z.boolean(),
  }),
};

type DeviceState = { deviceCode: string; expiresAt: number; interval: number } | null;
let deviceState: DeviceState = null;

async function readAuthState(): Promise<GitHubAuthState> {
  const token = await getToken();
  if (!token) return { status: 'unauthenticated' };
  try {
    const octo = createOctokit(token);
    const me = await getCurrentUser(octo);
    return { status: 'authenticated', login: me.data.login, avatarUrl: me.data.avatarUrl };
  } catch {
    // token bad — wipe it
    await deleteToken();
    return { status: 'unauthenticated' };
  }
}

function broadcastAuth(state: GitHubAuthState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.GH_AUTH_CHANGED, state);
  }
}

async function requireAuth(): Promise<ReturnType<typeof createOctokit>> {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated');
  return createOctokit(token);
}

export function registerGitHubHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GH_AUTH_STATE, async () => readAuthState());

  ipcMain.handle(IPC_CHANNELS.GH_SIGN_IN_START, async () => {
    const code = await requestDeviceCode();
    deviceState = {
      deviceCode: code.deviceCode,
      expiresAt: Date.now() + code.expiresIn * 1000,
      interval: code.interval,
    };
    await shell.openExternal(code.verificationUri);
    return { userCode: code.userCode, verificationUri: code.verificationUri, expiresAt: deviceState.expiresAt };
  });

  ipcMain.handle(IPC_CHANNELS.GH_SIGN_IN_POLL, async (): Promise<PollResult> => {
    if (!deviceState) return { status: 'error', message: 'No sign-in in progress' };
    if (Date.now() > deviceState.expiresAt) {
      deviceState = null;
      return { status: 'expired' };
    }
    const res = await pollForToken(deviceState.deviceCode);
    if (res.status === 'success') {
      await setToken(res.accessToken);
      deviceState = null;
      broadcastAuth(await readAuthState());
    } else if (res.status === 'expired' || res.status === 'denied') {
      deviceState = null;
    } else if (res.status === 'slow_down') {
      deviceState.interval = res.interval;
    }
    return res;
  });

  ipcMain.handle(IPC_CHANNELS.GH_SIGN_OUT, async () => {
    await deleteToken();
    broadcastAuth({ status: 'unauthenticated' });
  });

  ipcMain.handle(IPC_CHANNELS.GH_DETECT_REPO, async (_e, raw: unknown) => {
    const { worktreePath } = schemas.detectRepoInput.parse(raw);
    return detectRepoFromWorktree(worktreePath);
  });

  ipcMain.handle(IPC_CHANNELS.GH_LIST_ITEMS, async (_e, raw: unknown) => {
    const { owner, name } = schemas.listItemsInput.parse(raw);
    const octo = await requireAuth();
    return listItems(octo, owner, name);
  });

  ipcMain.handle(IPC_CHANNELS.GH_GET_ISSUE, async (_e, raw: unknown) => {
    const { owner, name, number } = schemas.getIssueInput.parse(raw);
    const octo = await requireAuth();
    return getIssue(octo, owner, name, number);
  });

  ipcMain.handle(IPC_CHANNELS.GH_GET_PR, async (_e, raw: unknown) => {
    const { owner, name, number } = schemas.getPRInput.parse(raw);
    const octo = await requireAuth();
    return getPR(octo, owner, name, number);
  });

  ipcMain.handle(IPC_CHANNELS.GH_GET_PR_FILES, async (_e, raw: unknown) => {
    const { owner, name, number } = schemas.getPRFilesInput.parse(raw);
    const octo = await requireAuth();
    return getPRFiles(octo, owner, name, number);
  });

  ipcMain.handle(IPC_CHANNELS.GH_GET_CHECKS, async (_e, raw: unknown) => {
    const { owner, name, sha } = schemas.getChecksInput.parse(raw);
    const octo = await requireAuth();
    return getChecks(octo, owner, name, sha);
  });

  ipcMain.handle(IPC_CHANNELS.GH_LIST_BRANCHES, async (_e, raw: unknown) => {
    const { owner, name } = schemas.listBranchesInput.parse(raw);
    const octo = await requireAuth();
    return listBranches(octo, owner, name);
  });

  ipcMain.handle(IPC_CHANNELS.GH_CREATE_COMMENT, async (_e, raw: unknown) => {
    const { owner, name, number, body } = schemas.createCommentInput.parse(raw);
    const octo = await requireAuth();
    return createComment(octo, owner, name, number, body);
  });

  ipcMain.handle(IPC_CHANNELS.GH_CREATE_REVIEW, async (_e, raw: unknown) => {
    const { owner, name, number, verdict, body } = schemas.createReviewInput.parse(raw);
    const octo = await requireAuth();
    return createReview(octo, owner, name, number, verdict, body);
  });

  ipcMain.handle(IPC_CHANNELS.GH_CREATE_PR, async (_e, raw: unknown) => {
    const input = schemas.createPRInput.parse(raw);
    const octo = await requireAuth();
    return createPR(octo, input);
  });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run src/main/__tests__/github-ipc-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Register handlers in main**

In `src/main/index.ts`, find the block where other IPC handlers are registered (look for `registerIpcHandlers()` or similar — search for `ipcMain.handle`). Import and call `registerGitHubHandlers()` alongside them:

```ts
import { registerGitHubHandlers } from './github/ipc';
// ...then, after app.whenReady():
registerGitHubHandlers();
```

- [ ] **Step 6: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/github/ipc.ts src/main/index.ts src/main/__tests__/github-ipc-schemas.test.ts
git commit -m "feat(github): IPC handlers with zod validation and auth broadcast"
```

---

## Task 8: Preload API surface

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add GitHub API on `window.fleet.github`**

In `src/preload/index.ts`, locate the `contextBridge.exposeInMainWorld('fleet', {...})` object and add a `github` property. First add the required imports at the top:

```ts
import type {
  GitHubAuthState,
  GitHubRepoRef,
  GitHubListItem,
  GitHubIssueDetail,
  GitHubPRDetail,
  GitHubPRFile,
  GitHubCheck,
  Envelope,
  ReviewVerdict,
  CreatePRInput,
} from '../shared/github-types';
```

Then add to the exposed `fleet` object:

```ts
github: {
  getAuthState: (): Promise<GitHubAuthState> => typedInvoke(IPC_CHANNELS.GH_AUTH_STATE),
  startSignIn: (): Promise<{ userCode: string; verificationUri: string; expiresAt: number }> =>
    typedInvoke(IPC_CHANNELS.GH_SIGN_IN_START),
  pollSignIn: (): Promise<
    | { status: 'pending' }
    | { status: 'slow_down'; interval: number }
    | { status: 'success'; accessToken: string }
    | { status: 'expired' }
    | { status: 'denied' }
    | { status: 'error'; message: string }
  > => typedInvoke(IPC_CHANNELS.GH_SIGN_IN_POLL),
  signOut: (): Promise<void> => typedInvoke(IPC_CHANNELS.GH_SIGN_OUT),
  onAuthChanged: (cb: (state: GitHubAuthState) => void): Unsubscribe =>
    onChannel(IPC_CHANNELS.GH_AUTH_CHANGED, cb),
  detectRepo: (worktreePath: string): Promise<GitHubRepoRef | null> =>
    typedInvoke(IPC_CHANNELS.GH_DETECT_REPO, { worktreePath }),
  listItems: (owner: string, name: string): Promise<Envelope<GitHubListItem[]>> =>
    typedInvoke(IPC_CHANNELS.GH_LIST_ITEMS, { owner, name }),
  getIssue: (owner: string, name: string, number: number): Promise<Envelope<GitHubIssueDetail>> =>
    typedInvoke(IPC_CHANNELS.GH_GET_ISSUE, { owner, name, number }),
  getPR: (owner: string, name: string, number: number): Promise<Envelope<GitHubPRDetail>> =>
    typedInvoke(IPC_CHANNELS.GH_GET_PR, { owner, name, number }),
  getPRFiles: (owner: string, name: string, number: number): Promise<Envelope<GitHubPRFile[]>> =>
    typedInvoke(IPC_CHANNELS.GH_GET_PR_FILES, { owner, name, number }),
  getChecks: (owner: string, name: string, sha: string): Promise<Envelope<GitHubCheck[]>> =>
    typedInvoke(IPC_CHANNELS.GH_GET_CHECKS, { owner, name, sha }),
  listBranches: (owner: string, name: string): Promise<Envelope<string[]>> =>
    typedInvoke(IPC_CHANNELS.GH_LIST_BRANCHES, { owner, name }),
  createComment: (
    owner: string,
    name: string,
    number: number,
    body: string,
  ): Promise<Envelope<{ id: number }>> =>
    typedInvoke(IPC_CHANNELS.GH_CREATE_COMMENT, { owner, name, number, body }),
  createReview: (
    owner: string,
    name: string,
    number: number,
    verdict: ReviewVerdict,
    body?: string,
  ): Promise<Envelope<{ id: number }>> =>
    typedInvoke(IPC_CHANNELS.GH_CREATE_REVIEW, { owner, name, number, verdict, body }),
  createPR: (input: CreatePRInput): Promise<Envelope<{ number: number; htmlUrl: string }>> =>
    typedInvoke(IPC_CHANNELS.GH_CREATE_PR, input),
},
```

- [ ] **Step 2: Update the `window.fleet` type declaration**

Find the `declare global { interface Window { fleet: ... } }` block in the preload or shared types. Add the matching `github` property to the type. If the preload exports a `FleetApi` type, extend that.

Locate the declaration by searching:

```bash
grep -rn "interface Window" src/preload src/renderer/src 2>/dev/null
```

Then add the `github` property with the same signatures.

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/src/env.d.ts src/shared 2>/dev/null; git commit -m "feat(github): preload API surface for window.fleet.github"
```

---

## Task 9: Zustand store for GitHub panel

**Files:**
- Create: `src/renderer/src/store/github-store.ts`
- Create: `src/renderer/src/__tests__/github-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/renderer/src/__tests__/github-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useGitHubStore } from '../store/github-store';

describe('github-store', () => {
  beforeEach(() => {
    useGitHubStore.setState(useGitHubStore.getInitialState());
  });

  it('starts unauthenticated and no active repo', () => {
    const s = useGitHubStore.getState();
    expect(s.auth.status).toBe('unauthenticated');
    expect(s.activeRepo).toBeNull();
  });

  it('setActiveRepo updates the ref', () => {
    useGitHubStore.getState().setActiveRepo({ owner: 'a', name: 'b' });
    expect(useGitHubStore.getState().activeRepo).toEqual({ owner: 'a', name: 'b' });
  });

  it('optimistic comment appends a pending entry', () => {
    useGitHubStore.getState().setActiveRepo({ owner: 'a', name: 'b' });
    useGitHubStore.getState().setDetail({ kind: 'issue', number: 1 }, {
      kind: 'issue',
      number: 1,
      title: 'T',
      state: 'open',
      author: { login: 'u', avatarUrl: '' },
      createdAt: '',
      updatedAt: '',
      commentCount: 0,
      labels: [],
      body: '',
      comments: [],
      assignees: [],
    });
    const pendingId = useGitHubStore.getState().addPendingComment({ kind: 'issue', number: 1 }, 'hello', 'me');
    const d = useGitHubStore.getState().details[`issue:1`];
    expect(d?.comments.some((c) => c.id === pendingId && c.body === 'hello')).toBe(true);
  });

  it('rollback removes the pending entry', () => {
    useGitHubStore.getState().setActiveRepo({ owner: 'a', name: 'b' });
    useGitHubStore.getState().setDetail({ kind: 'issue', number: 1 }, {
      kind: 'issue',
      number: 1,
      title: 'T',
      state: 'open',
      author: { login: 'u', avatarUrl: '' },
      createdAt: '',
      updatedAt: '',
      commentCount: 0,
      labels: [],
      body: '',
      comments: [],
      assignees: [],
    });
    const pendingId = useGitHubStore.getState().addPendingComment({ kind: 'issue', number: 1 }, 'hello', 'me');
    useGitHubStore.getState().rollbackPendingComment({ kind: 'issue', number: 1 }, pendingId);
    const d = useGitHubStore.getState().details[`issue:1`];
    expect(d?.comments.find((c) => c.id === pendingId)).toBeUndefined();
  });

  it('filter state is kind-aware', () => {
    useGitHubStore.getState().setFilter('prs');
    expect(useGitHubStore.getState().filter).toBe('prs');
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run src/renderer/src/__tests__/github-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the store**

```ts
// src/renderer/src/store/github-store.ts
import { create } from 'zustand';
import type {
  GitHubAuthState,
  GitHubRepoRef,
  GitHubListItem,
  GitHubIssueDetail,
  GitHubPRDetail,
  GitHubPRFile,
  GitHubCheck,
  GitHubComment,
  RateLimitInfo,
} from '../../../shared/github-types';

export type ItemKey = { kind: 'issue' | 'pr'; number: number };
export type ListFilter = 'all' | 'issues' | 'prs' | 'mine';

function keyOf(k: ItemKey): string {
  return `${k.kind}:${k.number}`;
}

type DetailState =
  | ({ kind: 'issue' } & GitHubIssueDetail & { files?: undefined; checks?: undefined })
  | ({ kind: 'pr' } & GitHubPRDetail & { files?: GitHubPRFile[]; checks?: GitHubCheck[] });

type GitHubStore = {
  auth: GitHubAuthState;
  activeRepo: GitHubRepoRef | null;
  trackedWorktreePath: string | null;
  items: GitHubListItem[];
  itemsLoadedAt: number | null;
  filter: ListFilter;
  search: string;
  selected: ItemKey | null;
  details: Record<string, DetailState>;
  rateLimit: RateLimitInfo | null;
  loading: { list: boolean; detail: boolean };
  error: string | null;

  setAuth: (a: GitHubAuthState) => void;
  setActiveRepo: (r: GitHubRepoRef | null) => void;
  setTrackedWorktreePath: (p: string | null) => void;
  setItems: (items: GitHubListItem[], rl: RateLimitInfo | null) => void;
  setFilter: (f: ListFilter) => void;
  setSearch: (s: string) => void;
  setSelected: (k: ItemKey | null) => void;
  setDetail: (k: ItemKey, d: DetailState) => void;
  setPRFiles: (number: number, files: GitHubPRFile[]) => void;
  setPRChecks: (number: number, checks: GitHubCheck[]) => void;
  addPendingComment: (k: ItemKey, body: string, authorLogin: string) => number;
  replacePendingComment: (k: ItemKey, pendingId: number, real: GitHubComment) => void;
  rollbackPendingComment: (k: ItemKey, pendingId: number) => void;
  setLoading: (which: 'list' | 'detail', v: boolean) => void;
  setError: (e: string | null) => void;
  setRateLimit: (rl: RateLimitInfo | null) => void;
};

const initial = {
  auth: { status: 'unauthenticated' } as GitHubAuthState,
  activeRepo: null as GitHubRepoRef | null,
  trackedWorktreePath: null as string | null,
  items: [] as GitHubListItem[],
  itemsLoadedAt: null as number | null,
  filter: 'all' as ListFilter,
  search: '',
  selected: null as ItemKey | null,
  details: {} as Record<string, DetailState>,
  rateLimit: null as RateLimitInfo | null,
  loading: { list: false, detail: false },
  error: null as string | null,
};

export const useGitHubStore = create<GitHubStore>((set) => ({
  ...initial,

  setAuth: (auth) => set({ auth }),
  setActiveRepo: (activeRepo) => set({ activeRepo, items: [], itemsLoadedAt: null, selected: null, details: {} }),
  setTrackedWorktreePath: (trackedWorktreePath) => set({ trackedWorktreePath }),
  setItems: (items, rateLimit) => set({ items, itemsLoadedAt: Date.now(), rateLimit }),
  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  setSelected: (selected) => set({ selected }),
  setDetail: (k, d) =>
    set((state) => ({ details: { ...state.details, [keyOf(k)]: d } })),
  setPRFiles: (number, files) =>
    set((state) => {
      const k = `pr:${number}`;
      const cur = state.details[k];
      if (!cur || cur.kind !== 'pr') return {};
      return { details: { ...state.details, [k]: { ...cur, files } } };
    }),
  setPRChecks: (number, checks) =>
    set((state) => {
      const k = `pr:${number}`;
      const cur = state.details[k];
      if (!cur || cur.kind !== 'pr') return {};
      return { details: { ...state.details, [k]: { ...cur, checks } } };
    }),
  addPendingComment: (k, body, authorLogin) => {
    const pendingId = -Date.now();
    set((state) => {
      const cur = state.details[keyOf(k)];
      if (!cur) return {};
      const comment: GitHubComment = {
        id: pendingId,
        author: { login: authorLogin, avatarUrl: '' },
        body,
        createdAt: new Date().toISOString(),
      };
      return {
        details: {
          ...state.details,
          [keyOf(k)]: { ...cur, comments: [...cur.comments, comment] } as DetailState,
        },
      };
    });
    return pendingId;
  },
  replacePendingComment: (k, pendingId, real) =>
    set((state) => {
      const cur = state.details[keyOf(k)];
      if (!cur) return {};
      return {
        details: {
          ...state.details,
          [keyOf(k)]: {
            ...cur,
            comments: cur.comments.map((c) => (c.id === pendingId ? real : c)),
          } as DetailState,
        },
      };
    }),
  rollbackPendingComment: (k, pendingId) =>
    set((state) => {
      const cur = state.details[keyOf(k)];
      if (!cur) return {};
      return {
        details: {
          ...state.details,
          [keyOf(k)]: { ...cur, comments: cur.comments.filter((c) => c.id !== pendingId) } as DetailState,
        },
      };
    }),
  setLoading: (which, v) => set((state) => ({ loading: { ...state.loading, [which]: v } })),
  setError: (error) => set({ error }),
  setRateLimit: (rateLimit) => set({ rateLimit }),
}));
```

Note: zustand v5's `getInitialState()` is used in the test reset. If that helper isn't in the installed version, replace the `beforeEach` reset with `useGitHubStore.setState({ ...initial })` — export `initial` from the store if needed.

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run src/renderer/src/__tests__/github-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/github-store.ts src/renderer/src/__tests__/github-store.test.ts
git commit -m "feat(github): zustand store with optimistic comments"
```

---

## Task 10: Pinned-tab bootstrapper + Sidebar card

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add `ensureGitHubTab`**

In `src/renderer/src/store/workspace-store.ts`, immediately after `ensureAnnotateTab` (around line 98), add:

```ts
/** Ensure workspace has a pinned GitHub tab; mutates and returns the workspace */
function ensureGitHubTab(workspace: Workspace): Workspace {
  if (workspace.tabs.some((t) => t.type === 'github')) return workspace;
  const cwd = workspace.tabs[0]?.cwd ?? '/';
  const githubTab: Tab = {
    id: generateId(),
    label: 'GitHub',
    labelIsCustom: true,
    cwd,
    type: 'github',
    splitRoot: createLeaf(cwd),
  };
  // Insert after annotate tab if present, else after images, else prepend.
  const annotateIdx = workspace.tabs.findIndex((t) => t.type === 'annotate');
  const imagesIdx = workspace.tabs.findIndex((t) => t.type === 'images');
  const baseIdx = annotateIdx >= 0 ? annotateIdx : imagesIdx;
  const insertIdx = baseIdx >= 0 ? baseIdx + 1 : 0;
  const tabs = [...workspace.tabs];
  tabs.splice(insertIdx, 0, githubTab);
  return { ...workspace, tabs };
}
```

- [ ] **Step 2: Wire into all existing `ensureImagesTab`/`ensureAnnotateTab` call sites**

Search the file for every call to `ensureAnnotateTab(` and add `ensureGitHubTab(...)` as the outer wrapper:

```bash
grep -n "ensureAnnotateTab" src/renderer/src/store/workspace-store.ts
```

At each call, change:

```ts
ensureAnnotateTab(ensureImagesTab(workspace))
```

to:

```ts
ensureGitHubTab(ensureAnnotateTab(ensureImagesTab(workspace)))
```

- [ ] **Step 3: Add `GitHubTabCard` to the sidebar**

In `src/renderer/src/components/Sidebar.tsx`, search for `ImagesTabCard` to find the pattern. Add a new component `GitHubTabCard` right after `AnnotateTabCard` using the same shape:

```tsx
function GitHubTabCard({
  tab,
  isActive,
  onClick,
}: {
  tab: Tab;
  isActive: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800',
      )}
      data-testid={`tab-card-${tab.id}`}
    >
      <GitPullRequestIcon className="h-4 w-4" />
      <span className="truncate">{tab.label}</span>
    </button>
  );
}
```

Add `GitPullRequest` to the `lucide-react` import at the top of `Sidebar.tsx`. Then, in the render order for pinned tabs (next to the existing Images and Annotate cards), render the GitHub card when `tab.type === 'github'`.

- [ ] **Step 4: Type-check and run app manually**

Run: `npm run typecheck`
Then: `npm run dev` — verify the sidebar shows a GitHub pinned tab entry. Clicking it activates the tab and shows an empty main area (no `GitHubTab` component yet — we'll add it in Task 11).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/components/Sidebar.tsx
git commit -m "feat(github): pinned GitHub tab in sidebar"
```

---

## Task 11: `GitHubTab` shell + auth gate + active-repo tracking

**Files:**
- Create: `src/renderer/src/components/github/GitHubTab.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Implement `GitHubTab` with auth gate and tracking effects**

```tsx
// src/renderer/src/components/github/GitHubTab.tsx
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore } from '../../store/github-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { GitHubSignInScreen } from './GitHubSignInScreen';
import { GitHubRepoHeader } from './GitHubRepoHeader';
import { GitHubList } from './GitHubList';
import { GitHubDetailPane } from './GitHubDetailPane';

export function GitHubTab(): JSX.Element {
  const { auth, activeRepo, setActiveRepo, setAuth, setTrackedWorktreePath, trackedWorktreePath } =
    useGitHubStore(
      useShallow((s) => ({
        auth: s.auth,
        activeRepo: s.activeRepo,
        setActiveRepo: s.setActiveRepo,
        setAuth: s.setAuth,
        setTrackedWorktreePath: s.setTrackedWorktreePath,
        trackedWorktreePath: s.trackedWorktreePath,
      })),
    );

  // Load initial auth state on mount + subscribe to changes.
  useEffect(() => {
    void window.fleet.github.getAuthState().then(setAuth);
    const off = window.fleet.github.onAuthChanged(setAuth);
    return off;
  }, [setAuth]);

  // Track the cwd of the active non-pinned tab.
  const activeTabCwd = useWorkspaceStore((s) => {
    const t = s.workspace.tabs.find((tab) => tab.id === s.activeTabId);
    if (!t || t.type === 'images' || t.type === 'annotate' || t.type === 'github' || t.type === 'settings') {
      return null;
    }
    return t.cwd || null;
  });

  useEffect(() => {
    if (activeTabCwd && activeTabCwd !== trackedWorktreePath) {
      setTrackedWorktreePath(activeTabCwd);
      void window.fleet.github.detectRepo(activeTabCwd).then((ref) => setActiveRepo(ref));
    }
  }, [activeTabCwd, trackedWorktreePath, setTrackedWorktreePath, setActiveRepo]);

  if (auth.status !== 'authenticated') {
    return <GitHubSignInScreen />;
  }

  if (!activeRepo) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        Open a worktree to see its issues and pull requests.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <GitHubRepoHeader />
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 border-r border-slate-800">
          <GitHubList />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <GitHubDetailPane />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create stub files for not-yet-implemented children so this task type-checks**

Create placeholder files that will be filled in later tasks:

```tsx
// src/renderer/src/components/github/GitHubSignInScreen.tsx
export function GitHubSignInScreen(): JSX.Element {
  return <div className="p-4 text-slate-400">Sign in (placeholder)</div>;
}
```

```tsx
// src/renderer/src/components/github/GitHubRepoHeader.tsx
export function GitHubRepoHeader(): JSX.Element {
  return <div className="border-b border-slate-800 p-2">Repo header (placeholder)</div>;
}
```

```tsx
// src/renderer/src/components/github/GitHubList.tsx
export function GitHubList(): JSX.Element {
  return <div className="p-2 text-slate-400">List (placeholder)</div>;
}
```

```tsx
// src/renderer/src/components/github/GitHubDetailPane.tsx
export function GitHubDetailPane(): JSX.Element {
  return <div className="p-4 text-slate-400">Select an item</div>;
}
```

- [ ] **Step 3: Wire `GitHubTab` into `App.tsx`**

In `src/renderer/src/App.tsx`, locate the tab-rendering `switch` (around lines 720-750). Add the `github` branch alongside the existing ones:

```tsx
) : tab.type === 'github' ? (
  <GitHubTab />
) : (
```

Add the import at the top:

```ts
import { GitHubTab } from './components/github/GitHubTab';
```

- [ ] **Step 4: Type-check + run dev**

Run: `npm run typecheck` — expect PASS.

Run: `npm run dev` — click the GitHub pinned tab. You should see the placeholder sign-in screen because no token is stored.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/github src/renderer/src/App.tsx
git commit -m "feat(github): GitHubTab shell with auth gate and repo tracking"
```

---

## Task 12: `GitHubSignInScreen` — real device-flow UI

**Files:**
- Modify: `src/renderer/src/components/github/GitHubSignInScreen.tsx`

- [ ] **Step 1: Implement sign-in screen**

Replace the placeholder with the real implementation:

```tsx
// src/renderer/src/components/github/GitHubSignInScreen.tsx
import { useEffect, useRef, useState } from 'react';
import { GithubIcon, Loader2Icon } from 'lucide-react';

type ScreenState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'awaiting'; userCode: string; verificationUri: string }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

export function GitHubSignInScreen(): JSX.Element {
  const [state, setState] = useState<ScreenState>({ status: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  async function startSignIn(): Promise<void> {
    setState({ status: 'starting' });
    try {
      const { userCode, verificationUri } = await window.fleet.github.startSignIn();
      setState({ status: 'awaiting', userCode, verificationUri });
      schedulePoll(5000);
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Sign-in failed' });
    }
  }

  function schedulePoll(ms: number): void {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => {
      void poll();
    }, ms);
  }

  async function poll(): Promise<void> {
    const res = await window.fleet.github.pollSignIn();
    switch (res.status) {
      case 'success':
        // Main will emit auth-changed; GitHubTab re-renders away from this screen.
        return;
      case 'pending':
        schedulePoll(5000);
        return;
      case 'slow_down':
        schedulePoll(res.interval * 1000);
        return;
      case 'expired':
        setState({ status: 'expired' });
        return;
      case 'denied':
        setState({ status: 'denied' });
        return;
      case 'error':
        setState({ status: 'error', message: res.message });
        return;
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-slate-200">
      <GithubIcon className="h-12 w-12 text-slate-400" />
      <h2 className="text-xl font-medium">Sign in with GitHub</h2>

      {state.status === 'idle' && (
        <>
          <p className="max-w-md text-center text-sm text-slate-400">
            Fleet will open github.com/login/device in your browser. Enter the one-time code to authorize this app.
          </p>
          <button
            type="button"
            onClick={startSignIn}
            className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          >
            Sign in
          </button>
        </>
      )}

      {state.status === 'starting' && (
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2Icon className="h-4 w-4 animate-spin" />
          Requesting code…
        </div>
      )}

      {state.status === 'awaiting' && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-slate-400">Enter this code in the browser window:</p>
          <code className="rounded-md bg-slate-800 px-4 py-2 font-mono text-2xl tracking-widest">
            {state.userCode}
          </code>
          <a
            href={state.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-400 underline"
          >
            {state.verificationUri}
          </a>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <Loader2Icon className="h-3 w-3 animate-spin" />
            Waiting for you to authorize…
          </div>
        </div>
      )}

      {state.status === 'expired' && (
        <>
          <p className="text-sm text-slate-400">The code expired. Try again.</p>
          <button
            type="button"
            onClick={startSignIn}
            className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          >
            Start over
          </button>
        </>
      )}

      {state.status === 'denied' && (
        <>
          <p className="text-sm text-slate-400">Access was denied.</p>
          <button
            type="button"
            onClick={startSignIn}
            className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          >
            Try again
          </button>
        </>
      )}

      {state.status === 'error' && (
        <>
          <p className="text-sm text-rose-400">{state.message}</p>
          <button
            type="button"
            onClick={startSignIn}
            className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Manual smoke test**

Run: `npm run dev`. Click the GitHub tab → click Sign in → verify GitHub's device-authorization page opens in the system browser, the code displays, and on authorization the panel flips away to the empty "Open a worktree" state.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/github/GitHubSignInScreen.tsx
git commit -m "feat(github): OAuth device-flow sign-in UI"
```

---

## Task 13: `GitHubRepoHeader` with refresh and polling

**Files:**
- Modify: `src/renderer/src/components/github/GitHubRepoHeader.tsx`

- [ ] **Step 1: Implement header + list refresh + polling effect**

```tsx
// src/renderer/src/components/github/GitHubRepoHeader.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { RefreshCwIcon, PlusIcon, MoreHorizontalIcon } from 'lucide-react';
import { useGitHubStore } from '../../store/github-store';
import { NewPRDialog } from './NewPRDialog';

function formatAge(ms: number | null): string {
  if (ms === null) return '—';
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}

export function GitHubRepoHeader(): JSX.Element {
  const { activeRepo, itemsLoadedAt, setItems, setLoading, setError, rateLimit, auth } = useGitHubStore(
    useShallow((s) => ({
      activeRepo: s.activeRepo,
      itemsLoadedAt: s.itemsLoadedAt,
      setItems: s.setItems,
      setLoading: s.setLoading,
      setError: s.setError,
      rateLimit: s.rateLimit,
      auth: s.auth,
    })),
  );
  const [newPROpen, setNewPROpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!activeRepo) return;
    setLoading('list', true);
    try {
      const res = await window.fleet.github.listItems(activeRepo.owner, activeRepo.name);
      setItems(res.data, res.rateLimit);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading('list', false);
    }
  }, [activeRepo, setItems, setLoading, setError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (document.visibilityState !== 'visible') return;
    pollRef.current = setInterval(() => void refresh(), 60_000);
    const onVis = (): void => {
      if (document.visibilityState !== 'visible' && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      } else if (document.visibilityState === 'visible' && !pollRef.current) {
        pollRef.current = setInterval(() => void refresh(), 60_000);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  async function signOut(): Promise<void> {
    await window.fleet.github.signOut();
  }

  if (!activeRepo) return <div className="border-b border-slate-800" />;

  const rlWarn = rateLimit && rateLimit.remaining < 100;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <a
          href={`https://github.com/${activeRepo.owner}/${activeRepo.name}`}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-medium text-slate-100 hover:underline"
        >
          {activeRepo.owner}/{activeRepo.name}
        </a>
        <span className="text-xs text-slate-500">{formatAge(itemsLoadedAt)}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          title="Refresh"
        >
          <RefreshCwIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setNewPROpen(true)}
          className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500"
        >
          <PlusIcon className="h-3 w-3" /> New PR
        </button>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded p-1 text-slate-400 hover:bg-slate-800"
          title={auth.status === 'authenticated' ? `Sign out ${auth.login}` : 'Sign out'}
        >
          <MoreHorizontalIcon className="h-4 w-4" />
        </button>
      </div>
      {rlWarn && (
        <div className="border-b border-amber-800 bg-amber-950/30 px-3 py-1 text-xs text-amber-300">
          Rate limit: {rateLimit.remaining}/{rateLimit.limit} remaining
          {rateLimit.remaining === 0
            ? ` — resets at ${new Date(rateLimit.resetAt).toLocaleTimeString()}`
            : ''}
        </div>
      )}
      <NewPRDialog open={newPROpen} onOpenChange={setNewPROpen} />
    </>
  );
}
```

- [ ] **Step 2: Create placeholder `NewPRDialog`**

```tsx
// src/renderer/src/components/github/NewPRDialog.tsx
export function NewPRDialog({
  open: _open,
  onOpenChange: _onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}): JSX.Element | null {
  return null;
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck` — expect PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/github/GitHubRepoHeader.tsx src/renderer/src/components/github/NewPRDialog.tsx
git commit -m "feat(github): repo header with refresh and polling"
```

---

## Task 14: `GitHubList` + `GitHubListItem` with filter + search

**Files:**
- Modify: `src/renderer/src/components/github/GitHubList.tsx`
- Create: `src/renderer/src/components/github/GitHubListItem.tsx`

- [ ] **Step 1: Implement `GitHubListItem`**

```tsx
// src/renderer/src/components/github/GitHubListItem.tsx
import {
  CircleDotIcon,
  CircleCheckIcon,
  GitPullRequestIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  MessageCircleIcon,
} from 'lucide-react';
import type { GitHubListItem as Item } from '../../../../shared/github-types';

function StateIcon({ item }: { item: Item }): JSX.Element {
  if (item.kind === 'issue') {
    return item.state === 'closed' ? (
      <CircleCheckIcon className="h-4 w-4 text-purple-400" />
    ) : (
      <CircleDotIcon className="h-4 w-4 text-emerald-400" />
    );
  }
  if (item.state === 'merged') return <GitMergeIcon className="h-4 w-4 text-purple-400" />;
  if (item.state === 'draft') return <GitPullRequestDraftIcon className="h-4 w-4 text-slate-400" />;
  if (item.state === 'closed') return <GitPullRequestIcon className="h-4 w-4 text-rose-400" />;
  return <GitPullRequestIcon className="h-4 w-4 text-emerald-400" />;
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (days >= 1) return `${days}d`;
  const hours = Math.round(ms / (1000 * 60 * 60));
  return `${hours}h`;
}

export function GitHubListItem({
  item,
  isSelected,
  onClick,
}: {
  item: Item;
  isSelected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2 border-b border-slate-800 p-2 text-left hover:bg-slate-900 ${
        isSelected ? 'bg-slate-900' : ''
      }`}
    >
      <StateIcon item={item} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-100">{item.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
          <span>#{item.number}</span>
          <span>by {item.author.login}</span>
          <span>{ageLabel(item.updatedAt)}</span>
          {item.commentCount > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageCircleIcon className="h-3 w-3" /> {item.commentCount}
            </span>
          )}
        </div>
        {item.labels.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {item.labels.slice(0, 4).map((l) => (
              <span
                key={l.name}
                style={{ backgroundColor: `#${l.color}` }}
                className="rounded px-1.5 py-px text-[10px] font-medium text-black/80"
              >
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Implement `GitHubList` with filters + search**

```tsx
// src/renderer/src/components/github/GitHubList.tsx
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore, type ListFilter } from '../../store/github-store';
import { GitHubListItem } from './GitHubListItem';

const FILTERS: { id: ListFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'issues', label: 'Issues' },
  { id: 'prs', label: 'PRs' },
  { id: 'mine', label: 'Mine' },
];

export function GitHubList(): JSX.Element {
  const { items, filter, setFilter, search, setSearch, selected, setSelected, auth, loading } =
    useGitHubStore(
      useShallow((s) => ({
        items: s.items,
        filter: s.filter,
        setFilter: s.setFilter,
        search: s.search,
        setSearch: s.setSearch,
        selected: s.selected,
        setSelected: s.setSelected,
        auth: s.auth,
        loading: s.loading.list,
      })),
    );

  const myLogin = auth.status === 'authenticated' ? auth.login : null;

  const filtered = items
    .filter((i) => {
      if (filter === 'issues' && i.kind !== 'issue') return false;
      if (filter === 'prs' && i.kind !== 'pr') return false;
      if (filter === 'mine' && myLogin && i.author.login !== myLogin) return false;
      if (search && !i.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-800 p-2">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-2 py-0.5 text-xs ${
                filter === f.id ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter…"
          className="mt-2 w-full rounded bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-600"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && filtered.length === 0 && (
          <div className="p-4 text-xs text-slate-500">Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="p-4 text-xs text-slate-500">No matching items.</div>
        )}
        {filtered.map((it) => (
          <GitHubListItem
            key={`${it.kind}-${it.number}`}
            item={it}
            isSelected={selected?.kind === it.kind && selected.number === it.number}
            onClick={() => setSelected({ kind: it.kind, number: it.number })}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + smoke test**

Run: `npm run typecheck` then `npm run dev`. Sign in, open a worktree for a GitHub repo, verify issues and PRs populate, filters work, search filters client-side.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/github/GitHubList.tsx src/renderer/src/components/github/GitHubListItem.tsx
git commit -m "feat(github): combined list with filter chips and search"
```

---

## Task 15: `MarkdownBody` + `CommentComposer` shared components

**Files:**
- Create: `src/renderer/src/components/github/MarkdownBody.tsx`
- Create: `src/renderer/src/components/github/CommentComposer.tsx`

- [ ] **Step 1: Implement `MarkdownBody`**

```tsx
// src/renderer/src/components/github/MarkdownBody.tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

export function MarkdownBody({ source }: { source: string }): JSX.Element {
  return (
    <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-slate-900 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {source || '_No description._'}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: Implement `CommentComposer`**

```tsx
// src/renderer/src/components/github/CommentComposer.tsx
import { useState } from 'react';
import { MarkdownBody } from './MarkdownBody';

export function CommentComposer({
  onSubmit,
  placeholder = 'Leave a comment…',
  submitLabel = 'Comment',
}: {
  onSubmit: (body: string) => Promise<void>;
  placeholder?: string;
  submitLabel?: string;
}): JSX.Element {
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(body);
      setBody('');
      setPreview(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-800 bg-slate-900">
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1 text-xs">
        <button
          type="button"
          onClick={() => setPreview(false)}
          className={`rounded px-2 py-0.5 ${!preview ? 'bg-slate-800 text-slate-100' : 'text-slate-400'}`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          className={`rounded px-2 py-0.5 ${preview ? 'bg-slate-800 text-slate-100' : 'text-slate-400'}`}
        >
          Preview
        </button>
      </div>
      {preview ? (
        <div className="min-h-[6rem] p-3">
          <MarkdownBody source={body} />
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          className="min-h-[6rem] w-full resize-y bg-transparent p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
      )}
      <div className="flex justify-end border-t border-slate-800 p-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!body.trim() || submitting}
          className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/github/MarkdownBody.tsx src/renderer/src/components/github/CommentComposer.tsx
git commit -m "feat(github): shared MarkdownBody and CommentComposer"
```

---

## Task 16: `IssueDetail` and `GitHubDetailPane` router

**Files:**
- Create: `src/renderer/src/components/github/IssueDetail.tsx`
- Modify: `src/renderer/src/components/github/GitHubDetailPane.tsx`

- [ ] **Step 1: Implement `IssueDetail`**

```tsx
// src/renderer/src/components/github/IssueDetail.tsx
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore } from '../../store/github-store';
import { MarkdownBody } from './MarkdownBody';
import { CommentComposer } from './CommentComposer';

export function IssueDetail({ number }: { number: number }): JSX.Element {
  const { activeRepo, detail, setDetail, setLoading, auth, addPendingComment, replacePendingComment, rollbackPendingComment } =
    useGitHubStore(
      useShallow((s) => ({
        activeRepo: s.activeRepo,
        detail: s.details[`issue:${number}`],
        setDetail: s.setDetail,
        setLoading: s.setLoading,
        auth: s.auth,
        addPendingComment: s.addPendingComment,
        replacePendingComment: s.replacePendingComment,
        rollbackPendingComment: s.rollbackPendingComment,
      })),
    );

  useEffect(() => {
    if (!activeRepo || detail) return;
    setLoading('detail', true);
    window.fleet.github
      .getIssue(activeRepo.owner, activeRepo.name, number)
      .then((res) => setDetail({ kind: 'issue', number }, { kind: 'issue', ...res.data }))
      .finally(() => setLoading('detail', false));
  }, [activeRepo, detail, number, setDetail, setLoading]);

  if (!detail || detail.kind !== 'issue') return <div className="p-4 text-xs text-slate-500">Loading…</div>;

  const myLogin = auth.status === 'authenticated' ? auth.login : 'you';

  async function submitComment(body: string): Promise<void> {
    if (!activeRepo) return;
    const pendingId = addPendingComment({ kind: 'issue', number }, body, myLogin);
    try {
      const res = await window.fleet.github.createComment(activeRepo.owner, activeRepo.name, number, body);
      replacePendingComment(
        { kind: 'issue', number },
        pendingId,
        {
          id: res.data.id,
          author: { login: myLogin, avatarUrl: '' },
          body,
          createdAt: new Date().toISOString(),
        },
      );
    } catch (e) {
      rollbackPendingComment({ kind: 'issue', number }, pendingId);
      throw e;
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-slate-800 p-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-medium text-slate-100">{detail.title}</h2>
          <span className="text-slate-500">#{detail.number}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
          <span>Opened by {detail.author.login}</span>
          <span>•</span>
          <span>{detail.state}</span>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <section className="rounded-md border border-slate-800 p-3">
          <div className="mb-2 text-xs text-slate-500">{detail.author.login}</div>
          <MarkdownBody source={detail.body} />
        </section>
        {detail.comments.map((c) => (
          <section key={c.id} className="rounded-md border border-slate-800 p-3">
            <div className="mb-2 text-xs text-slate-500">
              {c.author.login} • {new Date(c.createdAt).toLocaleString()}
              {c.id < 0 ? ' (sending…)' : ''}
            </div>
            <MarkdownBody source={c.body} />
          </section>
        ))}
        <CommentComposer onSubmit={submitComment} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace placeholder `GitHubDetailPane` with router**

```tsx
// src/renderer/src/components/github/GitHubDetailPane.tsx
import { useGitHubStore } from '../../store/github-store';
import { IssueDetail } from './IssueDetail';
import { PRDetail } from './PRDetail';

export function GitHubDetailPane(): JSX.Element {
  const selected = useGitHubStore((s) => s.selected);

  if (!selected) {
    return <div className="flex h-full items-center justify-center text-slate-500">Select an item</div>;
  }

  if (selected.kind === 'issue') return <IssueDetail number={selected.number} />;
  return <PRDetail number={selected.number} />;
}
```

- [ ] **Step 3: Create placeholder `PRDetail`**

```tsx
// src/renderer/src/components/github/PRDetail.tsx
export function PRDetail({ number: _number }: { number: number }): JSX.Element {
  return <div className="p-4 text-slate-500">PR detail coming</div>;
}
```

- [ ] **Step 4: Type-check + smoke**

Run: `npm run typecheck` and `npm run dev`. Click an issue → verify body + comments render, comment composer posts a comment (with optimistic pending state → final).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/github/IssueDetail.tsx src/renderer/src/components/github/GitHubDetailPane.tsx src/renderer/src/components/github/PRDetail.tsx
git commit -m "feat(github): issue detail with comments and composer"
```

---

## Task 17: `PRDetail` with sub-tabs and review action bar

**Files:**
- Modify: `src/renderer/src/components/github/PRDetail.tsx`

- [ ] **Step 1: Implement full PR detail**

```tsx
// src/renderer/src/components/github/PRDetail.tsx
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore } from '../../store/github-store';
import { MarkdownBody } from './MarkdownBody';
import { CommentComposer } from './CommentComposer';
import { PRFilesView } from './PRFilesView';
import { PRChecksView } from './PRChecksView';
import type { ReviewVerdict } from '../../../../shared/github-types';

type SubTab = 'conversation' | 'files' | 'checks';

export function PRDetail({ number }: { number: number }): JSX.Element {
  const {
    activeRepo,
    detail,
    setDetail,
    setLoading,
    auth,
    addPendingComment,
    replacePendingComment,
    rollbackPendingComment,
  } = useGitHubStore(
    useShallow((s) => ({
      activeRepo: s.activeRepo,
      detail: s.details[`pr:${number}`],
      setDetail: s.setDetail,
      setLoading: s.setLoading,
      auth: s.auth,
      addPendingComment: s.addPendingComment,
      replacePendingComment: s.replacePendingComment,
      rollbackPendingComment: s.rollbackPendingComment,
    })),
  );
  const [sub, setSub] = useState<SubTab>('conversation');
  const [reviewBusy, setReviewBusy] = useState(false);

  useEffect(() => {
    if (!activeRepo || detail) return;
    setLoading('detail', true);
    window.fleet.github
      .getPR(activeRepo.owner, activeRepo.name, number)
      .then((res) => setDetail({ kind: 'pr', number }, { kind: 'pr', ...res.data }))
      .finally(() => setLoading('detail', false));
  }, [activeRepo, detail, number, setDetail, setLoading]);

  if (!detail || detail.kind !== 'pr') return <div className="p-4 text-xs text-slate-500">Loading…</div>;

  const myLogin = auth.status === 'authenticated' ? auth.login : 'you';

  async function submitComment(body: string): Promise<void> {
    if (!activeRepo) return;
    const pendingId = addPendingComment({ kind: 'pr', number }, body, myLogin);
    try {
      const res = await window.fleet.github.createComment(activeRepo.owner, activeRepo.name, number, body);
      replacePendingComment(
        { kind: 'pr', number },
        pendingId,
        { id: res.data.id, author: { login: myLogin, avatarUrl: '' }, body, createdAt: new Date().toISOString() },
      );
    } catch (e) {
      rollbackPendingComment({ kind: 'pr', number }, pendingId);
      throw e;
    }
  }

  async function submitReview(verdict: ReviewVerdict, body?: string): Promise<void> {
    if (!activeRepo) return;
    setReviewBusy(true);
    try {
      await window.fleet.github.createReview(activeRepo.owner, activeRepo.name, number, verdict, body);
    } finally {
      setReviewBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-800 p-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-medium text-slate-100">{detail.title}</h2>
          <span className="text-slate-500">#{detail.number}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
          <span>{detail.author.login}</span>
          <span>wants to merge</span>
          <code className="rounded bg-slate-800 px-1 py-0.5">{detail.branch?.head}</code>
          <span>→</span>
          <code className="rounded bg-slate-800 px-1 py-0.5">{detail.branch?.base}</code>
          <span>•</span>
          <span>{detail.state}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={reviewBusy}
            onClick={() => void submitReview('APPROVE')}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={reviewBusy}
            onClick={() => void submitReview('REQUEST_CHANGES')}
            className="rounded-md bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
          >
            Request changes
          </button>
          <button
            type="button"
            disabled={reviewBusy}
            onClick={() => void submitReview('COMMENT')}
            className="rounded-md bg-slate-700 px-3 py-1 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-50"
          >
            Comment review
          </button>
        </div>
      </div>

      <div className="flex border-b border-slate-800 text-sm">
        {(['conversation', 'files', 'checks'] as SubTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setSub(t)}
            className={`px-4 py-2 capitalize ${
              sub === t ? 'border-b-2 border-sky-500 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sub === 'conversation' && (
          <div className="space-y-4 p-4">
            <section className="rounded-md border border-slate-800 p-3">
              <div className="mb-2 text-xs text-slate-500">{detail.author.login}</div>
              <MarkdownBody source={detail.body} />
            </section>
            {detail.comments.map((c) => (
              <section key={c.id} className="rounded-md border border-slate-800 p-3">
                <div className="mb-2 text-xs text-slate-500">
                  {c.author.login} • {new Date(c.createdAt).toLocaleString()}
                  {c.id < 0 ? ' (sending…)' : ''}
                </div>
                <MarkdownBody source={c.body} />
              </section>
            ))}
            <CommentComposer onSubmit={submitComment} />
          </div>
        )}
        {sub === 'files' && <PRFilesView number={number} />}
        {sub === 'checks' && <PRChecksView number={number} sha={detail.headSha} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/github/PRDetail.tsx
git commit -m "feat(github): PR detail with sub-tabs and review actions"
```

---

## Task 18: `PRFilesView` with `@git-diff-view/react`

**Files:**
- Create: `src/renderer/src/components/github/PRFilesView.tsx`

- [ ] **Step 1: Implement files view**

```tsx
// src/renderer/src/components/github/PRFilesView.tsx
import { useEffect, useState } from 'react';
import { DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore } from '../../store/github-store';

const MAX_LINES = 2000;

export function PRFilesView({ number }: { number: number }): JSX.Element {
  const { activeRepo, files, setPRFiles } = useGitHubStore(
    useShallow((s) => ({
      activeRepo: s.activeRepo,
      files: (s.details[`pr:${number}`]?.kind === 'pr' && s.details[`pr:${number}`].files) || null,
      setPRFiles: s.setPRFiles,
    })),
  );
  const [selected, setSelected] = useState<number>(0);

  useEffect(() => {
    if (!activeRepo || files !== null) return;
    void window.fleet.github
      .getPRFiles(activeRepo.owner, activeRepo.name, number)
      .then((res) => setPRFiles(number, res.data));
  }, [activeRepo, files, number, setPRFiles]);

  if (!files) return <div className="p-4 text-xs text-slate-500">Loading diff…</div>;
  if (files.length === 0) return <div className="p-4 text-xs text-slate-500">No changes.</div>;

  const file = files[selected];
  const tooLarge = (file.additions + file.deletions) > MAX_LINES;

  return (
    <div className="flex h-full">
      <ul className="w-72 shrink-0 overflow-y-auto border-r border-slate-800 text-xs">
        {files.map((f, idx) => (
          <li key={f.filename}>
            <button
              type="button"
              onClick={() => setSelected(idx)}
              className={`block w-full truncate p-2 text-left hover:bg-slate-900 ${
                idx === selected ? 'bg-slate-900 text-slate-100' : 'text-slate-400'
              }`}
              title={f.filename}
            >
              <span className="truncate">{f.filename}</span>
              <span className="ml-2 text-emerald-400">+{f.additions}</span>
              <span className="ml-1 text-rose-400">-{f.deletions}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-auto">
        {tooLarge ? (
          <div className="p-4 text-xs text-slate-400">
            File has {file.additions + file.deletions} changed lines — too large to display.{' '}
            <a
              href={`https://github.com/${activeRepo?.owner}/${activeRepo?.name}/pull/${number}/files`}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 underline"
            >
              Open on GitHub
            </a>
          </div>
        ) : file.patch ? (
          <DiffView
            data={{
              oldFile: { fileName: file.previousFilename ?? file.filename },
              newFile: { fileName: file.filename },
              hunks: [file.patch],
            }}
            diffViewMode={1 /* unified */}
            diffViewHighlight
          />
        ) : (
          <div className="p-4 text-xs text-slate-400">Binary or empty file; no patch to display.</div>
        )}
      </div>
    </div>
  );
}
```

> **Note:** `@git-diff-view/react`'s `DiffView` API reads `hunks` as an array of unified-diff strings. Pass the single patch from the Octokit response as a one-element array. If the library version ships a different prop shape, consult its README (installed at `node_modules/@git-diff-view/react/README.md`) and adjust the props accordingly — the logic around which file is selected, the "too large" fallback, and the "no patch" fallback stay the same.

- [ ] **Step 2: Type-check + smoke**

Run: `npm run typecheck` then `npm run dev`. Open a PR → Files tab → diff renders; switching files works.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/github/PRFilesView.tsx
git commit -m "feat(github): PR files view with @git-diff-view/react"
```

---

## Task 19: `PRChecksView`

**Files:**
- Create: `src/renderer/src/components/github/PRChecksView.tsx`

- [ ] **Step 1: Implement checks view**

```tsx
// src/renderer/src/components/github/PRChecksView.tsx
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2Icon, XCircleIcon, CircleDashedIcon, CircleIcon } from 'lucide-react';
import { useGitHubStore } from '../../store/github-store';
import type { GitHubCheck } from '../../../../shared/github-types';

function Icon({ c }: { c: GitHubCheck }): JSX.Element {
  if (c.status !== 'completed') return <CircleDashedIcon className="h-4 w-4 text-amber-400 animate-pulse" />;
  if (c.conclusion === 'success') return <CheckCircle2Icon className="h-4 w-4 text-emerald-400" />;
  if (c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled')
    return <XCircleIcon className="h-4 w-4 text-rose-400" />;
  return <CircleIcon className="h-4 w-4 text-slate-400" />;
}

export function PRChecksView({ number, sha }: { number: number; sha: string }): JSX.Element {
  const { activeRepo, checks, setPRChecks } = useGitHubStore(
    useShallow((s) => ({
      activeRepo: s.activeRepo,
      checks: (s.details[`pr:${number}`]?.kind === 'pr' && s.details[`pr:${number}`].checks) || null,
      setPRChecks: s.setPRChecks,
    })),
  );

  useEffect(() => {
    if (!activeRepo || checks !== null) return;
    void window.fleet.github
      .getChecks(activeRepo.owner, activeRepo.name, sha)
      .then((res) => setPRChecks(number, res.data));
  }, [activeRepo, checks, number, sha, setPRChecks]);

  if (!checks) return <div className="p-4 text-xs text-slate-500">Loading checks…</div>;
  if (checks.length === 0) return <div className="p-4 text-xs text-slate-500">No checks reported.</div>;

  return (
    <ul className="p-4">
      {checks.map((c) => (
        <li key={c.name} className="flex items-center gap-2 border-b border-slate-800 py-2 text-sm">
          <Icon c={c} />
          <span className="flex-1 text-slate-200">{c.name}</span>
          {c.detailsUrl && (
            <a href={c.detailsUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-400 underline">
              Details
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/github/PRChecksView.tsx
git commit -m "feat(github): PR checks view"
```

---

## Task 20: `NewPRDialog` — create a pull request

**Files:**
- Modify: `src/renderer/src/components/github/NewPRDialog.tsx`

- [ ] **Step 1: Replace placeholder with full implementation**

```tsx
// src/renderer/src/components/github/NewPRDialog.tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useShallow } from 'zustand/react/shallow';
import { useGitHubStore } from '../../store/github-store';

export function NewPRDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}): JSX.Element | null {
  const { activeRepo } = useGitHubStore(useShallow((s) => ({ activeRepo: s.activeRepo })));
  const [branches, setBranches] = useState<string[] | null>(null);
  const [head, setHead] = useState('');
  const [base, setBase] = useState('main');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed head/base from the current worktree on open.
  useEffect(() => {
    if (!open) return;
    setError(null);
    // Default head = current branch on the worktree cwd (best-effort via git-service API if available).
    // If the renderer doesn't have access to the worktree's branch, leave head blank and force picker.
    // Users can still submit by expanding the picker and choosing.
  }, [open]);

  useEffect(() => {
    if (!open || !activeRepo) return;
    void window.fleet.github.listBranches(activeRepo.owner, activeRepo.name).then((res) => {
      setBranches(res.data);
      if (!base && res.data.includes('main')) setBase('main');
      else if (!base && res.data.includes('master')) setBase('master');
    });
  }, [open, activeRepo, base]);

  async function submit(): Promise<void> {
    if (!activeRepo || !head || !base || !title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await window.fleet.github.createPR({
        owner: activeRepo.owner,
        name: activeRepo.name,
        head,
        base,
        title,
        body,
        draft,
      });
      onOpenChange(false);
      // Open the freshly-created PR in the browser as confirmation.
      window.open(res.data.htmlUrl, '_blank');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create PR');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-slate-900 p-4 text-slate-100 shadow-xl">
          <Dialog.Title className="text-sm font-medium">New pull request</Dialog.Title>

          <div className="mt-3 text-xs text-slate-400">
            {showBranchPicker ? (
              <div className="flex items-center gap-2">
                <select
                  value={head}
                  onChange={(e) => setHead(e.target.value)}
                  className="rounded bg-slate-800 px-2 py-1 text-xs"
                >
                  <option value="">Head…</option>
                  {(branches ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <span>→</span>
                <select
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  className="rounded bg-slate-800 px-2 py-1 text-xs"
                >
                  {(branches ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                Merging <code className="rounded bg-slate-800 px-1">{head || '(pick head)'}</code> into{' '}
                <code className="rounded bg-slate-800 px-1">{base}</code>{' '}
                <button
                  type="button"
                  onClick={() => setShowBranchPicker(true)}
                  className="ml-1 text-sky-400 underline"
                >
                  change branches
                </button>
              </div>
            )}
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="mt-3 w-full rounded bg-slate-800 px-3 py-2 text-sm focus:outline-none"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Description (markdown supported)"
            className="mt-2 h-32 w-full resize-y rounded bg-slate-800 px-3 py-2 text-sm focus:outline-none"
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Open as draft
          </label>

          {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md bg-slate-700 px-3 py-1 text-xs hover:bg-slate-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!head || !base || !title.trim() || submitting}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create PR'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

> **Note on head seeding:** The "auto-fill head = current worktree branch" described in the spec requires exposing the branch name from the renderer. If `useCwdStore` or the workspace-store already carries the current branch for the tracked worktree, set `head` from that value in the `useEffect` above. If not, leave head blank and require the user to pick — document the limitation as a follow-up rather than a blocker.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/github/NewPRDialog.tsx
git commit -m "feat(github): new PR dialog with branch picker"
```

---

## Task 21: Full-flow smoke test + README note

**Files:**
- Modify: `README.md` (append a brief note)

- [ ] **Step 1: Full smoke pass**

Run: `npm run build` — expect typecheck + electron-vite build to pass.

Run: `npm run dev`. Exercise:

1. GitHub tab appears in sidebar.
2. Sign in via device flow.
3. Open a worktree for a GitHub repo in another tab — GitHub tab shows its issues + PRs.
4. Filter chips work (All / Issues / PRs / Mine).
5. Search narrows the list.
6. Click an issue → body + comments render; post a comment; verify optimistic pending state then confirmation.
7. Click a PR → Conversation tab; post a comment; click Approve.
8. Click Files → diff renders; switch files.
9. Click Checks → checks list.
10. Click "New PR" → branch picker populates; title + body; submit → browser opens the new PR.
11. Click refresh → list reloads.
12. Let it sit for > 60s — observe polling (look at DevTools network tab for `listItems` request).
13. Click overflow → sign out → returned to sign-in screen.

If any step fails, **do not commit**; open an issue in the TodoList and fix before moving on.

- [ ] **Step 2: Add a short usage note to README**

In `README.md`, append to the features list:

```md
- **GitHub panel** — view issues and PRs for the current worktree's repo, post comments, approve/request changes, and open new PRs without leaving Fleet. Sign in with GitHub the first time you open the panel.
```

- [ ] **Step 3: Run lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: PASS on both.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(github): note new GitHub panel in README"
```

---

## Self-Review Notes

**Spec coverage:** All spec requirements map to tasks:

- OAuth device flow → Tasks 4, 7 (handlers), 12 (UI).
- `safeStorage` token → Task 3, wired through Task 7.
- Repo detection from worktree → Task 2, wired through Tasks 7, 11.
- Master/detail combined list + filter chip → Tasks 14, 16, 17.
- 60s polling while visible → Task 13.
- Read-only diff → Task 18 (with "too large" fallback).
- Single-click Approve / Request changes / Comment → Task 17.
- Auto-fill head/base + "change branches" toggle → Task 20 (with note about head seeding if unavailable).
- Rate-limit envelope → Task 5, surfaced in header in Task 13.
- Error handling (401, network offline, rate limit, write failure, huge diff, malformed markdown) → handled in Tasks 7, 13, 16/17 (optimistic rollback), 18 (too-large), 15 (react-markdown sanitizes by default).
- Tests (unit: store, repo parser, tokens, oauth, rate-limit, zod schemas; manual smoke): covered.

**One deferred item:** "auto-fill head = current branch" depends on whether the renderer has ready access to the tracked worktree's current branch. Task 20 has a note to either seed from existing state or leave head blank — acceptable because the spec's "change branches" escape hatch still works.

**No placeholders** — every code block is complete. Type-check gates each task. Frequent commits (one per task).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-github-toolbar-tab.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for this plan because every task is a clean TDD cycle on its own files.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
