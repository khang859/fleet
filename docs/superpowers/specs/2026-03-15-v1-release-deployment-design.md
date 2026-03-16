# Fleet v1 Release & Deployment Design

## Overview

Set up CI/CD to build, sign, and publish Fleet as a cross-platform Electron app (macOS, Windows, Linux) via GitHub Actions, with auto-updates from GitHub Releases.

## Release Trigger

- **Tag push:** `v*` tags (e.g., `v1.0.0`) trigger the workflow automatically.
- **Manual dispatch:** `workflow_dispatch` allows triggering from the Actions UI as a fallback.

## Build Matrix

| Platform | Runner            | Arch   | Artifacts          |
|----------|-------------------|--------|--------------------|
| macOS    | `macos-latest`    | x64 + arm64 (universal) | DMG |
| Windows  | `windows-latest`  | x64    | NSIS installer (.exe) |
| Linux    | `ubuntu-latest`   | x64    | AppImage, .deb     |

Each platform builds in parallel as a separate job.

## Workflow: `.github/workflows/release.yml`

### Steps (per platform)

1. **Checkout** — `actions/checkout@v4`
2. **Setup Node** — `actions/setup-node@v4` with Node 20, npm cache
3. **Install dependencies** — `npm ci`
4. **Build** — `electron-vite build`
5. **Package & Sign** — `electron-builder` with platform-specific flags
6. **Upload to GitHub Release** — `softprops/action-gh-release@v2`

### macOS-specific

- Code signing via `CSC_LINK` (base64 .p12) and `CSC_KEY_PASSWORD` env vars
- Notarization via `electron-builder`'s built-in `notarize` config using `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`
- Hardened runtime entitlements already exist at `build/entitlements.mac.plist`
- Build universal binary (arm64 + x64) for maximum compatibility

### Windows-specific

- No code signing for v1 (can add later with a Windows Authenticode cert)
- NSIS installer target

### Linux-specific

- No signing required
- AppImage (portable) + .deb (apt-installable)

## Auto-Updates

`electron-updater` is already imported in `src/main/index.ts`. It will:

1. Check GitHub Releases for updates on app launch (after `app.whenReady()`)
2. Download in background if a newer version is found
3. Notify the user and install on next restart

### Configuration

Add `publish` provider to the `build` config in `package.json`:

```json
"publish": {
  "provider": "github",
  "owner": "khang859",
  "repo": "fleet"
}
```

### Main process integration

The auto-updater code is already partially set up (line 18-19 of `src/main/index.ts`). Add:

```typescript
app.whenReady().then(() => {
  // ... existing window creation ...

  // Check for updates (non-blocking, no-op in dev)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});
```

## `package.json` Changes

1. **Version:** bump from `0.1.0` to `1.0.0`
2. **Author:** update from `example.com` to actual author
3. **Build config additions:**
   - Add `publish` block (GitHub provider)
   - Add `linux` target config (AppImage + deb)
   - Change mac target to universal (arm64 + x64)
   - Add `afterSign` notarize hook or inline notarize config

## Required GitHub Secrets

| Secret              | Purpose                              |
|---------------------|--------------------------------------|
| `CSC_LINK`          | Base64-encoded .p12 signing cert     |
| `CSC_KEY_PASSWORD`  | Certificate password                 |
| `APPLE_ID`          | Apple ID for notarization            |
| `APPLE_APP_PASSWORD`| App-specific password for notarization|
| `APPLE_TEAM_ID`     | Apple Developer Team ID              |

`GITHUB_TOKEN` is automatically provided by GitHub Actions.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `.github/workflows/release.yml` | Create | CI/CD release workflow |
| `package.json` | Modify | Version bump, publish config, Linux targets, universal mac |
| `src/main/index.ts` | Modify | Add `autoUpdater.checkForUpdatesAndNotify()` call |

## Release Process

1. Bump version in `package.json` to `1.0.0`
2. Commit: `chore: prepare v1.0.0 release`
3. Tag: `git tag v1.0.0`
4. Push: `git push origin main --tags`
5. GitHub Actions builds all platforms, creates GitHub Release with artifacts
6. Users download from GitHub Releases page

## Out of Scope for v1

- Windows code signing (Authenticode certificate)
- Homebrew tap / apt repository
- Landing page / website
- Crash reporting (Sentry)
