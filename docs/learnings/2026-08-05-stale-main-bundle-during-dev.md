# Stale main bundle makes E2E verification lie

## What happened

While verifying agent compaction end to end, the running app kept producing summaries in the *old* prompt format, several minutes after the prompt had been rewritten in `src/shared/agent-context.ts`.
The renderer half of the same change was live - HMR had picked it up - so the app looked current.

Two rounds of debugging went into the model's behaviour ("is it anchoring on the previous summary?") before the actual cause turned up:

```
$ stat -f "%Sm %N" -t "%H:%M:%S" out/main/index.mjs src/shared/agent-context.ts
22:16:32 out/main/index.mjs
22:29:14 src/shared/agent-context.ts
```

The electron-vite dev server's **main-process watcher had stopped rebuilding**.
`out/main/index.mjs` was 13 minutes older than the source.
`touch src/main/agent/agent-service.ts` did not wake it either.
Restarting `npm run dev` fixed it immediately.

## Why it is worth writing down

The renderer and the main process fail differently in dev, and only one of them is loud:

- **Renderer:** HMR applies instantly, or the screen goes blank. You notice.
- **Main:** a stale bundle keeps serving the *previous* build with no error anywhere. The app works. It is just running code you no longer have.

So an E2E result that exercises main - IPC handlers, prompts, API requests, anything in `src/main` or in `src/shared` imported *by* main - can silently be a verification of code from ten minutes ago.
That is worse than no verification, because it reads as a pass.

## What to do

Before trusting any E2E check that crosses into main, confirm the bundle is newer than the source:

```bash
stat -f "%Sm %N" -t "%H:%M:%S" out/main/index.mjs <the file you changed>
```

Or assert on the built artifact directly, which also catches a partial rebuild:

```bash
grep -c "some distinctive string from your change" out/main/index.mjs
```

If the bundle is stale, restart the dev server rather than touching files to prod the watcher - `touch` did not work here.
Ask first: the dev server belongs to whoever started it, and a second `npm run dev` breaks `fleet-drive`.

## Related

A settings key added to `DEFAULT_SETTINGS` is a cheap liveness probe for main, since main merges defaults on load:

```bash
npm run drive -- eval 'window.fleet.settings.get().then(s => { window.__probe = s.ai.agent })'
npm run drive -- eval 'JSON.stringify(window.__probe)'
```

If the new key is missing, main is stale - stop and fix that before reading anything else into the behaviour.
