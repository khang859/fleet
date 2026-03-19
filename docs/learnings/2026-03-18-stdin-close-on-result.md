# Crew stays `active` after mission completes — stdin close + escalation fallback

## What happened

After Claude emits a `result` stream message (mission complete), the crew process didn't exit.
The crew status stayed `active` indefinitely (up to the 15-minute timeout).

## Root cause: wrong mental model about `result` messages

The original assumption was: **`result` messages are informational — the process exit handler triggers cleanup.**

This is wrong. Claude Code with `--input-format stream-json` keeps stdin open and waits for more
input after emitting a `result` message. Because stdin is never closed, the process never exits,
`proc.on('exit')` never fires, `cleanup()` never runs, and crew status stays `active` forever.

## Fix: close stdin on `result` + escalation fallback

**Step 1 — Close stdin** so the process receives EOF and exits naturally, triggering
`proc.on('exit')` → `cleanup()` → status transition.

**Step 2 — Add escalation fallback** in case stdin close alone isn't enough (e.g., the process
ignores EOF). After closing stdin, set timers that send SIGTERM after 5 seconds and SIGKILL after
10 seconds if the process hasn't exited. Clear the timers on exit. This matches the pattern already
used in `kill()` and `handleTimeout()`.

```ts
} else if (msg.type === 'result') {
  try { this.process?.stdin?.end() } catch { /* ignore */ }
  const proc = this.process
  if (proc) {
    const sigterm = setTimeout(() => {
      if (!proc.killed) { try { proc.kill('SIGTERM') } catch { /* already dead */ } }
    }, 5000)
    const sigkill = setTimeout(() => {
      if (!proc.killed) { try { proc.kill('SIGKILL') } catch { /* already dead */ } }
    }, 10000)
    proc.once('exit', () => { clearTimeout(sigterm); clearTimeout(sigkill) })
  }
}
```

## Lesson

Whenever a process needs to be terminated, always pair the graceful signal with an escalation
fallback (5s SIGTERM → 10s SIGKILL). Don't rely on the process respecting EOF or any single signal.
The `kill()` and `handleTimeout()` methods in `hull.ts` are the canonical pattern to follow.
