# Starbase runtime utility process notes

## What happened

When extracting Starbase orchestration into an Electron utility process, two integration details caused immediate friction:

1. `utilityProcess.fork()` needed a filesystem path string, not a `URL` object.
2. The existing socket server is typed against concrete service classes, so runtime-backed proxy objects needed explicit `unknown` casts at the service-registry boundary.

## Fix

- Convert the runtime entry URL with `fileURLToPath()` before calling `utilityProcess.fork()`.
- Keep the socket server contract stable by introducing a runtime-backed service registry adapter and casting at the boundary rather than widening the socket server internals during the extraction.

## Takeaway

For Electron process-split refactors, treat the process-launch boundary and typed service boundaries as separate problems:

- Normalize launch inputs to plain filesystem paths early.
- Preserve stable external contracts first, then clean up internal typing in a follow-up refactor once behavior is verified.
