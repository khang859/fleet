# Fleet v1 Release & Deployment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up GitHub Actions CI/CD to build, sign, notarize, and publish Fleet v1.0.0 for macOS, Windows, and Linux with auto-updates from GitHub Releases.

**Architecture:** Modify the existing `build.yml` workflow to add Linux, macOS signing/notarization, manual dispatch, and a version-tag verification step. Three parallel jobs (one per platform). The app's existing electron-updater integration checks for updates on launch.

**Tech Stack:** GitHub Actions, electron-builder, electron-updater

---

## Chunk 1: Package config and code guards

### Task 1: Update `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update version, author, homepage**

- `"version"`: `"0.1.0"` → `"1.0.0"`
- `"author"`: `"example.com"` → `"Khang Nguyen"`
- `"homepage"`: `"https://electron-vite.org"` → `"https://github.com/khang859/fleet"`

- [ ] **Step 2: Replace `build` config**

Replace the entire `"build"` block with:

```json
"build": {
  "appId": "com.fleet.app",
  "productName": "Fleet",
  "directories": {
    "buildResources": "build"
  },
  "publish": {
    "provider": "github",
    "owner": "khang859",
    "repo": "fleet"
  },
  "mac": {
    "category": "public.app-category.developer-tools",
    "target": [
      {
        "target": "dmg",
        "arch": ["universal"]
      }
    ],
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": {
      "teamId": ""
    }
  },
  "win": {
    "target": [
      {
        "target": "nsis",
        "arch": ["x64"]
      }
    ]
  },
  "linux": {
    "target": [
      {
        "target": "AppImage",
        "arch": ["x64"]
      },
      {
        "target": "deb",
        "arch": ["x64"]
      }
    ],
    "category": "Development"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

Note: `notarize.teamId` is left empty — electron-builder reads `APPLE_TEAM_ID` env var at build time. If that doesn't work, set the team ID directly.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: update build config for v1.0.0 release"
```

### Task 2: Production guards in main process

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Guard auto-updater behind `app.isPackaged`**

Wrap lines 304-307:

```typescript
if (app.isPackaged) {
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
}
```

- [ ] **Step 2: Guard DevTools and debug logging**

Wrap `openDevTools` (line 63) and the `did-finish-load` debug handler (lines 66-80):

```typescript
if (!app.isPackaged) {
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.on('did-finish-load', () => {
    // ... existing debug DOM code ...
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "chore: guard devtools and auto-updater behind app.isPackaged"
```

## Chunk 2: CI workflow and release

### Task 3: Update GitHub Actions workflow

**Files:**
- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Rewrite `build.yml` with per-platform jobs**

Replace the entire file with a workflow that has:
- `workflow_dispatch` trigger (manual fallback)
- Separate jobs for mac, win, linux (native modules need platform-specific builds)
- CI job for PRs/pushes (typecheck + test only, no packaging)
- Version-tag match verification
- macOS signing + notarization secrets
- Linux added to the matrix

```yaml
name: CI & Release

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Type check
        run: npx tsc --noEmit
      - name: Run tests
        run: npm test

  verify-version:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check tag matches package.json
        run: |
          TAG=${GITHUB_REF#refs/tags/v}
          PKG=$(node -p "require('./package.json').version")
          if [ "$TAG" != "$PKG" ]; then
            echo "::error::Version mismatch: tag=v$TAG but package.json=$PKG"
            exit 1
          fi

  release-mac:
    needs: [ci, verify-version]
    if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Build and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: npx electron-vite build && npx electron-builder --mac --publish always

  release-win:
    needs: [ci, verify-version]
    if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Build and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-vite build && npx electron-builder --win --publish always

  release-linux:
    needs: [ci, verify-version]
    if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Build and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-vite build && npx electron-builder --linux --publish always
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "ci: add cross-platform release workflow with signing and notarization"
```

### Task 4: Tag and release v1.0.0

- [ ] **Step 1: Push all changes**

```bash
git push origin main
```

- [ ] **Step 2: Create and push the tag**

```bash
git tag v1.0.0
git push origin v1.0.0
```

- [ ] **Step 3: Monitor the workflow**

```bash
gh run watch
```

Verify all three release jobs complete and artifacts appear on the GitHub Release.

- [ ] **Step 4: Verify the release**

```bash
gh release view v1.0.0
```

Expected artifacts: `.dmg` (macOS), `.exe` (Windows), `.AppImage` + `.deb` (Linux), plus `latest-mac.yml`/`latest-linux.yml`/`latest.yml` auto-update manifests.
