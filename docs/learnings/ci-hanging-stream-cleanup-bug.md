# CI Hanging Issue: Stream Cleanup Bug in Navigator

## Problem

CI sometimes hung for ~45 minutes while other times it completed in <1 minute. This was caused by child processes spawning in tests without proper stream cleanup.

## Root Cause

`Navigator.dispatch()` spawns a real child process (`claude` binary) with stdio pipes. When the spawn fails (ENOENT on CI), the error handler didn't properly clean up the stdio streams:

```typescript
const proc = spawn('claude', cmdArgs, {
  stdio: ['pipe', 'pipe', 'pipe'] // Creates stdout, stderr, stdin
});

// ... attach event handlers ...

proc.on('error', (err) => {
  // Old code: didn't destroy streams!
  clearTimeout(timer);
  this.running.delete(event.executionId);
  // Bug: streams stay alive, keeping Node.js process running indefinitely
});
```

When spawn fails before the process fully initializes, the stdout/stderr streams created with `stdio: ['pipe', 'pipe', 'pipe']` never properly close. These open streams cause Node.js to stay alive indefinitely, waiting for them.

vitest's `forceExit: true` config (added in commit 5fa4ca9) was a workaround, but it only masked the symptom by force-exiting when tests timeout (explaining the ~45 minute variable waits).

## Solution

Properly destroy all stdio streams in error handlers and shutdown methods:

1. **Error handler (line 255-272)**: Destroy stdout, stderr, stdin when spawn fails
2. **shutdown() method (line 370-380)**: Destroy streams before killing processes

```typescript
proc.on('error', (err) => {
  clearTimeout(timer);
  this.running.delete(event.executionId);
  // Destroy streams to allow Node.js to exit
  try {
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    proc.stdin?.destroy();
  } catch {
    /* ignore */
  }
  // ... rest of error handling ...
});

shutdown(): void {
  for (const [k, entry] of this.running) {
    // Destroy streams first
    try {
      entry.proc.stdout?.destroy();
      entry.proc.stderr?.destroy();
      entry.proc.stdin?.destroy();
    } catch {
      /* ignore */
    }
    try {
      entry.proc.kill('SIGKILL');
    } catch {
      /* already dead */
    }
    this.running.delete(k);
  }
  this.timedOut.clear();
}
```

## Impact

- **Before**: Tests sometimes hung for 45+ minutes waiting for streams to close
- **After**: Full test suite completes in ~20 seconds consistently
- **All 664 tests pass** with the fix

## Key Lesson

When dealing with spawned child processes:

1. Always destroy streams when processes fail or exit
2. Don't rely on process.kill() alone—cleanup streams explicitly
3. Test for both success and failure paths (spawn fails with ENOENT on CI)
4. Watch for hanging tests that eventually timeout—stream leaks are a common cause
