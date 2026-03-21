# Starbase runtime utility process notes

## What happened

When extracting Starbase orchestration into an Electron utility process, two integration details caused immediate friction:

1. `utilityProcess.fork()` needed a filesystem path string, not a `URL` object.
2. The existing socket server is typed against concrete service classes, so runtime-backed proxy objects needed explicit `unknown` casts at the service-registry boundary.
3. Passing `process.env` directly through `child.postMessage()` caused Electron structured clone failures (`Error: An object could not be cloned.`), even though the values were string-like at runtime.
4. Utility-process `'message'` handlers were written against a `{ data }` wrapper, but Electron delivered the payload directly in this integration. That left `message.data` as `undefined` and crashed on the first response.
5. The sandboxed preload script was emitted as ESM and used top-level `await`, but Electron executed it as a classic preload script. That failed at startup with `Cannot use import statement outside a module`.
6. On macOS, the Starbase utility process imports a native addon (`better-sqlite3`). Electron utility processes may need `allowLoadingUnsignedLibraries` enabled to load native libraries in that helper context.
7. Preload-safe IPC constants were mixed into `shared/constants.ts` with main-process-only `path`/`os` imports. Once preload was bundled as sandbox-safe CommonJS, that transitive Node builtin import broke preload loading with `module not found: path`.
8. After bootstrap completed, the Starbase utility process still exited because Electron let the helper terminate once its event loop went idle. A registered `process.parentPort.on('message', ...)` handler was not sufficient to keep it resident.
9. After switching from Electron utility-process IPC to plain Node child-process IPC, the parent runtime client still treated any object with a `data` field as a wrapper envelope. Normal successful responses also have `data`, so `runtime.getAdmiralBootstrapData` lost its `id` and the parent hung waiting for a reply that had already arrived.
10. xterm.js was crashing in dev with `Cannot read properties of undefined (reading 'dimensions')` from `Viewport.syncScrollArea()`. The trigger was React `StrictMode` double-mounting terminal components while xterm still had deferred viewport work queued for the first instance.

## Fix

- Convert the runtime entry URL with `fileURLToPath()` before calling `utilityProcess.fork()`.
- Keep the socket server contract stable by introducing a runtime-backed service registry adapter and casting at the boundary rather than widening the socket server internals during the extraction.
- Normalize `process.env` into a fresh plain `{ [key]: string }` object before sending bootstrap args to the utility process, and catch the fire-and-forget bootstrap promise so startup failures update runtime status without also producing an unhandled rejection warning.
- Accept both raw payloads and `{ data }` envelopes in utility-process message handlers so the runtime client and child process stay robust to Electron’s delivered shape.
- Emit the preload bundle in CommonJS-compatible form for sandboxed windows, avoid top-level `await` there, and resolve the preload path defensively so the main process can load either `.js` or `.mjs` during local rebuild transitions.
- When a macOS utility process loads native Node addons, launch it with `allowLoadingUnsignedLibraries: true` and log `child-process-gone` details so helper-launch failures are visible from the main process.
- Keep preload-safe shared values in a pure module with no Node builtin imports. Re-export them from richer main-process modules if needed, but do not make preload transitively depend on `path`, `os`, or filesystem helpers.
- Keep a ref'd handle alive inside long-lived Electron utility processes if they must remain resident between messages. A parentPort listener alone may not prevent clean exit after startup work finishes.
- When supporting multiple IPC envelope shapes, discriminate wrapper messages precisely. A Node IPC success response like `{ id, ok, data }` must not be unwrapped as though it were `{ data: payload }`.
- If xterm is mounted in dev under React `StrictMode`, watch for deferred viewport/render work firing after the first mount has already been disposed. If that happens, prefer removing `StrictMode` at the renderer root over piling on renderer timing hacks.

## Takeaway

For Electron process-split refactors, treat the process-launch boundary and typed service boundaries as separate problems:

- Normalize launch inputs to plain filesystem paths early.
- Normalize IPC payloads to plain structured-clone-safe data before crossing Electron process boundaries.
- Treat Electron utility-process message payload shape as an integration detail to verify directly, not as a browser `MessageEvent` by default.
- Treat sandboxed preload execution as a stricter target than main-process ESM. A preload file that works as an ESM bundle is not automatically loadable by Electron’s sandboxed preload runner.
- For macOS utility processes, account for native addon loading separately from ordinary Node/Electron script execution.
- Keep mixed-environment shared modules honest. If a file is imported by preload or renderer, it cannot also contain main-only Node builtin setup.
- Treat “clean exit right after successful bootstrap” as a lifecycle bug, not a bootstrap bug. Instrument the child first so you can tell whether it failed or simply went idle and exited.
- Be careful with “helpful” IPC unwrapping. If two message shapes both contain `data`, key presence is not enough; check the full shape before transforming the payload.
- When a terminal library crashes only in dev and the stack points into deferred render/viewport work, check React lifecycle behavior first. `StrictMode` double-mounts can look like renderer timing bugs.
- Preserve stable external contracts first, then clean up internal typing in a follow-up refactor once behavior is verified.
