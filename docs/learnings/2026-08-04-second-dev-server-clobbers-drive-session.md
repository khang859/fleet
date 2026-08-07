# Learnings: a second `npm run dev` clobbers the fleet-drive session (2026-08-04)

## Symptom

`npm run drive -- screenshot` failed against a perfectly healthy dev window:

```
Connected to CDP on port 57856 but found no Fleet window at http://localhost:5174.
```

## Root cause

A dev server was already running (renderer on `http://localhost:5173`).
Starting a second `npm run dev` made Vite fall back to port 5174 and rewrite `.fleet-drive/session.json` with that URL.
`scripts/drive/core.ts:44` only accepts a page whose URL starts with `session.rendererUrl`, so the still-running original window no longer matched and `attach()` threw.
Killing the second dev server does not restore the file - the stale `rendererUrl` stays behind.

## Fix

Check for a live window before starting a dev server:

```bash
curl -s http://localhost:9222/json/version   # only the fixed inspect port; not conclusive
npm run drive -- screenshot                  # the real check: does drive attach?
```

If the session file is already stale, repair it instead of restarting the app - read the live target's URL and write it back:

```bash
curl -s http://localhost:<cdp-port>/json/list | grep '"url"'
# then set rendererUrl in .fleet-drive/session.json to that origin
```

`lsof -nP -iTCP -sTCP:LISTEN | grep Electron` finds the CDP port when the session file is untrustworthy.
