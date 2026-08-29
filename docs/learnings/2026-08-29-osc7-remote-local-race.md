# OSC 7 cannot be routed on a polled "is this pane remote?" flag

## What happened

The remote-shell integration added a second consumer of OSC 7.
`NotificationDetector` reads it as the pane's *local* working directory; `PtyOscBridge` reads it as the *remote* one.
Both were gated on the same `ActivityTracker.isRemote(paneId)` flag.

That flag is not live.
It is set by `pollProcesses()`, which `src/main/index.ts` schedules on a fixed 2000 ms interval.
Fleet's own rc snippet fires OSC 7 from the remote shell's very first prompt, which on a key-auth host over a fast link lands well inside that window.

So for any host that already had the snippet installed, a remote absolute path could be handled as a local one.
Two things then went wrong at once:

1. `ptyManager.updateCwd` stored a path that does not exist on this machine, and that path reaches the saved workspace layout, which drives respawn on restart.
2. The `cwd-changed` handler called `cwdPoller.markOsc7Seen`, and `CwdPoller` treats that as permanent: the next tick calls `stopPolling` and nothing ever restarts it.

The fallback that would have corrected the wrong path was switched off by the same wrong event.
There was no user-visible error at any point.

## The fix

OSC 7 carries `file://<host>/<path>`, and the host part exists for exactly this purpose.
`src/main/osc-host.ts` compares the first label of that host, lowercased, against `os.hostname()`.
An empty host, `localhost`, or a match all read as local, so a shell that omits the host behaves exactly as it did before.

Both consumers now use two independent signals rather than one:

- `NotificationDetector.checkOSC7` skips when `isRemote(paneId) || isForeignOsc7Host(payload)`.
- `PtyOscBridge` accepts when `isRemote(paneId) || isForeignOsc7Host(payload)`.

Neither signal is sufficient alone.
The flag is a poll behind; the host name is absent from some shells' output.

## The general lesson

A polled flag describes the past, not the present.
Do not use one to route a message that can arrive faster than the poll interval, especially when a wrong route is silent and self-reinforcing.
Prefer a discriminator carried inside the message itself.

Watch in particular for the shape where a misrouted event also disables the mechanism that would have detected the misrouting.
`markOsc7Seen` is that shape: it is a one-way latch fed by the very data whose trustworthiness was in question.
