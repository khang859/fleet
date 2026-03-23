---
name: release
description: This skill should be used when creating a new release for the Fleet Electron app. It covers version bumping, tagging, creating draft GitHub releases, and monitoring CI builds. Triggers on "release", "new version", "bump version", "tag release", "publish release", or any release workflow request.
---

# Release

## Overview

This skill guides the release process for the Fleet Electron app. Fleet uses electron-builder with GitHub Releases as the publish provider. The release workflow (`.github/workflows/release.yml`) builds for macOS (arm64 + x64), Windows, and Linux when a version tag is pushed. A final `publish-release` job automatically publishes the draft release after all builds succeed. CI checks live separately in `.github/workflows/ci.yml`.

## Critical Rule

**Releases MUST be created as draft.** When `electron-builder --publish always` runs in CI, it uploads artifacts to an existing draft GitHub release matching the tag. If the release is not draft (or does not exist as draft), the build artifacts will fail to publish to it. The `publish-release` CI job handles publishing automatically after all builds complete.

## Release Workflow

### Step 1: Determine the New Version

Follow semver conventions:
- **Patch** (1.2.0 → 1.2.1): Bug fixes only
- **Minor** (1.2.0 → 1.3.0): New features, backward compatible
- **Major** (1.2.0 → 2.0.0): Breaking changes

### Step 2: Bump the Version in `package.json`

Update the `"version"` field in `package.json` to the new version. Do not modify `package-lock.json` manually — run `npm install` to sync it.

```bash
npm install
```

### Step 3: Add a Changelog Entry

**This step is required.** The CI release workflow runs `scripts/extract-release-notes.ts` which looks for a `## vX.Y.Z` heading in `CHANGELOG.md` matching the tag. If the entry is missing, all build jobs will fail.

Add the entry at the top of `CHANGELOG.md`:

```markdown
## v<NEW_VERSION>
- Summary of changes
```

### Step 4: Commit Version Bump and Changelog Together

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: bump version to <NEW_VERSION>"
```

### Step 5: Push to Main

```bash
git push origin main
```

### Step 6: Create Draft Release and Push Tag

First, create the draft release on GitHub:

```bash
gh release create v<NEW_VERSION> --draft --title "v<NEW_VERSION>" --generate-notes
```

Then create and push the tag locally. Draft releases do not create remote tags, so the tag must be pushed to trigger the release workflow:

```bash
git tag v<NEW_VERSION>
git push origin v<NEW_VERSION>
```

**Important:** The tag must point to a commit that already includes the `CHANGELOG.md` entry. If you accidentally pushed the tag before the changelog commit, move the tag:

```bash
git tag -d v<NEW_VERSION> && git push origin :refs/tags/v<NEW_VERSION>
git tag v<NEW_VERSION> && git push origin v<NEW_VERSION>
```

### Step 7: Monitor CI

The tag push triggers the CI workflow. Monitor it:

```bash
gh run list --limit 5
gh run watch
```

Five jobs run for a tag release:
- `release-mac-arm64` (macos-15)
- `release-mac-x64` (macos-15-intel)
- `release-win` (windows-latest)
- `release-linux` (ubuntu-latest)
- `publish-release` — runs after all four build jobs succeed, automatically publishes the draft release

Each build job uses `electron-builder --publish always` which uploads artifacts to the draft release. Once all four succeed, `publish-release` flips the release from draft to published.

### Step 7: Verify the Release

After CI completes (including the `publish-release` job), verify the release is published with all artifacts:

```bash
gh release view v<NEW_VERSION>
```

Expected artifacts:
- macOS: `Fleet-<VERSION>-arm64.dmg`, `Fleet-<VERSION>.dmg` (x64), `latest-mac.yml`
- Windows: `Fleet-Setup-<VERSION>.exe`, `latest.yml`
- Linux: `Fleet-<VERSION>.AppImage`, `Fleet-<VERSION>.deb`, `latest-linux.yml`

The `latest-*.yml` files are auto-update manifests used by `electron-updater`.

## Troubleshooting

### "No changelog entry found" error in CI
The `extract-release-notes.ts` script requires a `## vX.Y.Z` heading in `CHANGELOG.md` matching the tag. Add the entry, commit it to main, then move the tag to that commit:

```bash
git tag -d v<NEW_VERSION> && git push origin :refs/tags/v<NEW_VERSION>
git tag v<NEW_VERSION> && git push origin v<NEW_VERSION>
```

Do **not** use `gh run rerun` — the re-run checks out the tag commit, not main, so new commits won't be picked up unless the tag is moved first.

### CI build job failed — release stays in draft
The `publish-release` job only runs when all four build jobs succeed. If any build fails, the release remains draft. Fix the issue and re-run the failed job:

```bash
gh run rerun <RUN_ID> --failed
```

`electron-builder` publish is idempotent for draft releases — it will upload/overwrite artifacts. Once the re-run succeeds, `publish-release` will run automatically.

### Artifacts missing from release
Verify the release is still in draft state. If it was accidentally published before CI completed, delete the release (not the tag), recreate as draft, and re-run CI:

```bash
gh release delete v<NEW_VERSION> --yes
gh release create v<NEW_VERSION> --draft --title "v<NEW_VERSION>" --generate-notes --target main
gh workflow run release.yml
```

### Version mismatch error in CI
The `verify-version` job checks that the tag matches `package.json`. Ensure the version bump commit was pushed before the tag was created.
