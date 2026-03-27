# Learnings: Initial Fleet Implementation (2026-03-14)

## electron-store v11 requires ESM output

**Problem:** electron-store v11 is ESM-only. electron-vite defaults to CJS output for the main process, causing `Store is not a constructor` at runtime.

**Fix:** Configure `electron.vite.config.ts` to output ESM:

```ts
main: {
  build: {
    rollupOptions: {
      output: {
        format: 'es';
      }
    }
  }
}
```

Also requires replacing `__dirname` with `fileURLToPath(new URL('.', import.meta.url))` and updating `package.json` main field from `.js` to `.mjs`.

---

## node-pty spawn-helper missing execute bit (macOS)

**Problem:** `posix_spawnp failed` when spawning a PTY. node-pty v1.1.0 ships `prebuilds/darwin-arm64/spawn-helper` with `644` permissions (no execute bit).

**Root cause:** Known bug — [microsoft/node-pty#850](https://github.com/microsoft/node-pty/issues/850). The prebuild tarball doesn't preserve the execute permission.

**Fix:** `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` — added to `postinstall` script.

**Lesson:** When a native module fails with a cryptic OS-level error, search the module's GitHub issues before trying random fixes like rebuilding.

---

## React StrictMode double-mounts break xterm.js

**Problem:** StrictMode mounts → unmounts → remounts components. This causes:

1. **Duplicate PTY creation** — `paneId already exists` error
2. **Disposed terminal access** — `_isDisposed` errors from WebGL addon
3. **Orphaned terminals** — first mount's terminal renders into a DOM node that gets removed

**Fix:**

- Track created PTYs in a module-level `Set<string>` that survives remounts
- Create a fresh Terminal instance on each mount (don't try to reuse across StrictMode cycles)
- Use Canvas addon instead of WebGL (WebGL context is harder to clean up safely)

**Lesson:** Don't try to be clever with StrictMode — the simplest approach is to let the first mount's resources be disposed and recreate on second mount, while guarding side effects (like PTY creation) with a persistent Set.

---

## xterm.js Unicode11Addon requires allowProposedApi

**Problem:** `You must set the allowProposedApi option to true to use proposed API` error crashes the terminal component.

**Fix:** Add `allowProposedApi: true` to the Terminal constructor options.

---

## CSP blocks Vite HMR in development

**Problem:** The scaffold's `index.html` had a strict Content-Security-Policy (`script-src 'self'`) that blocks Vite's injected HMR scripts, resulting in a blank page.

**Fix:** Remove the static CSP meta tag from `index.html` — CSP should be set dynamically in production builds, not hardcoded in the HTML during dev.

---

## xterm.js container needs explicit height chain

**Problem:** Terminal renders but has zero height, appearing invisible.

**Fix:** Ensure `html, body, #root` all have `height: 100%` in CSS, and every parent in the flex chain has explicit height (`h-full`, `h-screen`).

---

## xterm.js fit addon doesn't account for CSS padding

**Problem:** When the terminal container has `padding`, the fit addon calculates dimensions based on the outer container size, but the padding reduces available space. Content at the bottom gets cut off.

**Fix:** Use a two-div pattern — outer div has padding and background color, inner div is the xterm mount target with `h-full w-full`. The fit addon then measures the inner div correctly.

---

## Window not draggable with hiddenInset title bar

**Problem:** `titleBarStyle: 'hiddenInset'` removes the native title bar, making the window immovable.

**Fix:** Add `-webkit-app-region: drag` CSS to a header area (sidebar top + a thin strip across the top of the main content area). Use `pt-8` on the sidebar header to make room for the traffic lights.

---

## Electron app branding only works in packaged builds

**Problem:** `productName` in `package.json`, `app.setName('Fleet')`, and `app.dock.setIcon()` don't change the dock tooltip or menu bar name from "Electron" during development.

**Root cause:** In dev mode, you're running the raw `Electron.app` binary. The dock name comes from the binary's `Info.plist`, not from your app code. Only a packaged build (via `electron-builder`) renames the binary and its `Info.plist` fields (`CFBundleDisplayName`, `CFBundleName`, etc.).

**Fix:** Don't waste time trying to fix dev-mode branding. Set up `productName`, `appId`, and `build` config in `package.json`, and verify branding via `npm run build:mac` → open the `.app` from `dist/`.

---

## Packaged app crashes with "Object has been destroyed" on close

**Problem:** Closing the app window throws `TypeError: Object has been destroyed` from node-pty's `onData` callback.

**Root cause:** PTY processes outlive the `BrowserWindow`. When the window closes, the `BrowserWindow` is destroyed, but PTYs keep emitting data. The IPC callback tries to call `win.webContents.send()` on the destroyed window.

**Fix:** Two-part fix:

1. Kill all PTYs in the `mainWindow.on('close')` event (before destruction)
2. Guard every IPC send with `if (w && !w.isDestroyed())` — don't capture `win` at PTY creation time, call `getWindow()` each time instead

---

## macOS code signing mismatch crashes packaged app

**Problem:** Packaged `.app` crashes on launch with `"mapping process and mapped file (non-platform) have different Team IDs"` in the crash log.

**Root cause:** electron-builder's ad-hoc signing doesn't properly sign nested frameworks on newer macOS versions. The main binary and `Electron Framework.framework` end up with mismatched signatures.

**Fix:** After packaging, re-sign with `codesign --force --deep --sign - dist/mac-arm64/Fleet.app`. Also clear quarantine with `xattr -cr` if needed.

---

## electron-builder universal build fails with node-pty

**Problem:** `electron-builder --mac` with `"arch": ["universal"]` fails: `Detected file ... that's the same in both x64 and arm64 builds and not covered by the x64ArchFiles rule`.

**Root cause:** node-pty's prebuilt native binaries have arch-specific paths but electron-builder's universal merge can't reconcile them.

**Fix:** Build for a single architecture instead: `"arch": ["arm64"]` for Apple Silicon or `"arch": ["x64"]` for Intel. Universal builds with native modules need additional `x64ArchFiles` configuration.

---

## xterm.js fit addon throws "dimensions" error on mount

**Problem:** `Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')` when the terminal first mounts.

**Root cause:** `fitAddon.fit()` is called synchronously after `term.open(container)`, but xterm's render service hasn't completed its first layout pass yet, so `_renderService.dimensions` is undefined.

**Fix:** Defer the initial fit call with `requestAnimationFrame()`. The `ResizeObserver` will handle subsequent resizes.

---

## General lessons

- **Research before fixing:** When hitting an obscure error, search GitHub issues for the specific error message before trying solutions. The `posix_spawnp` fix was a 30-second `chmod` but took several wrong attempts (rebuilding, changing env vars) before researching.
- **electron-vite scaffold uses `src/renderer/src/`:** The scaffold nests renderer source one level deeper than you might expect. Adapt to the scaffold's structure rather than fighting it.
- **ESM migration in Electron is straightforward:** Just set rollup output format to `'es'` and fix `__dirname` usage. No need for `"type": "module"` in package.json.
