# Learnings: Windows release builds broke on the VS 2026 runner image (2026-06-11)

## node-gyp 11.x cannot detect Visual Studio 2026

**Problem:** The `release-win` job failed during the v2.67.0 release with
`Error: Could not find any Visual Studio installation to use` while
electron-builder rebuilt `node-pty`. Nothing in the repo had changed — GitHub
is migrating the `windows-latest` label to the new `windows-2025-vs2026`
runner image (notice in the job log: redirect complete by June 15, 2026).
That image ships only Visual Studio 2026 (internal version 18.x), which
node-gyp 11.x's `find-visualstudio.js` does not recognize
(nodejs/node-gyp#3282). Fleet resolved node-gyp 11.5.0 transitively via
`electron-builder → app-builder-lib → @electron/rebuild`. A plain re-run
fails identically — this is deterministic, not flaky.

**Fix:** Force node-gyp ≥ 12.1.0 (where VS 2026 support landed) with an npm
override in `package.json`:

```json
"overrides": {
  "node-gyp": "^12.1.0"
}
```

Then `npm install` to update the lockfile. node-gyp 12 requires Node
^20.17 || >=22; CI uses Node 22.

**Release-flow reminder:** the fix commit must be on the tag, not just main.
Move the tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`,
re-tag, re-push) instead of `gh run rerun`, which checks out the old tag
commit. electron-builder uploads are idempotent against the draft release,
so already-built platforms just overwrite their artifacts.
