# macOS auto-updates require packaged ZIP artifacts, not GitHub source ZIPs

**Problem:** In-app updates on macOS failed with `ZIP file not provided` even though the GitHub release tag page exposed a `.zip` download.

**Root cause:** The `.zip` on `archive/refs/tags/...` is GitHub's source archive for the repository tag, not a packaged macOS app artifact. `electron-updater` reads `latest-mac.yml` and expects a packaged macOS ZIP alongside the DMG. The release only published DMGs, so the updater had nothing installable to use.

**Fix:** Publish `zip` targets for macOS in `electron-builder` in addition to `dmg`, and keep the release config aligned with the actual per-architecture mac builds (`arm64` and `x64` rather than `universal` in this repo).
