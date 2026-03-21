# Packaged app can lose `fleet.sock` when Starbase bootstrap fails before socket startup

## What happened

`fleet.sock` worked in `npm run dev` but was missing in the installed macOS app. The socket layer was not the direct failure: `SocketSupervisor` is only created after Starbase bootstrap succeeds in [`src/main/index.ts`](/Users/khangnguyen/Development/fleet/src/main/index.ts). In the packaged app, bootstrap failed first, so the socket was never started.

Two packaged-only issues showed up in the logs:

1. The Starbase runtime crashed loading `better-sqlite3` because the bundled native addon architecture did not match the running app (`x86_64` addon inside an `arm64` app).
2. The packaged app was deriving its Starbase workspace from `process.cwd()`, which resolves to `/` when launched normally from Finder.

## Fix

- Rebuild native Electron dependencies during release packaging on each macOS job with `npx electron-builder install-app-deps`.
- Re-enable `electron-builder` native rebuilds by setting `npmRebuild: true` so packaging does not blindly reuse an incompatible prebuilt addon.
- Resolve the bootstrap workspace defensively in packaged mode: prefer a real absolute working directory, then `PWD`, then fall back to the user's home directory instead of `/`.

## Takeaway

- If `fleet.sock` is missing in production, inspect the Starbase bootstrap logs first. The socket is downstream of runtime startup.
- Treat native Electron addons as release artifacts that must match the target architecture, not just the local dev environment.
- Never key persistent workspace state off raw `process.cwd()` in a GUI app without a fallback for Finder-style launches.
