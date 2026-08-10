# Learnings: where Fleet's PTY path actually runs out of road (2026-08-09)

Measured while costing out a Rust/Zig rewrite.
The harness is a small Electron app that imports the real `PtyManager` and drives it in three layers - `ingest` (node-pty into main, discard), `ipc` (plus the structured-clone hop to the renderer), `full` (plus real `xterm.Terminal.write` and the drain ack).
Where the throughput falls off between layers names the guilty one.

## The main process is not the bottleneck, and it is not close

On an 8-core M1, unthrottled ANSI-heavy output:

| layer | 1 pane | 2 | 4 | 8 |
| --- | --- | --- | --- | --- |
| ingest | 23.7 MB/s | 35.8 | 48.7 | 66.9 |
| ipc | 22.9 | 34.0 | 46.0 | 59.7 |
| full | 16.1 | 30.2 | 43.1 | 57.6 |

IPC costs 3-10%.
xterm costs the rest.
Main-process event-loop lag never exceeded **1.8ms p95 in any run in the entire sweep**, including the runs where keystroke-to-screen had blown out to 313ms - main sat idle while the renderer drowned.
Confirmed in the real app under `npm run dev` with 16 streaming panes: renderer 88.5% CPU, main 18.5%.

So any plan that moves PTY reading or flushing off the main thread is optimising a layer that was never the constraint.

## The cost is the number of live panes, not the bytes

Paced generators, full path, per-agent byte budget swept:

| KB/s per agent | 8 panes | 16 | 32 | 48 |
| --- | --- | --- | --- | --- |
| 50 | 60fps / echo 18ms | 60fps / 25ms | 60fps / 51ms | 46fps / 93ms |
| 200 | 60fps / 23ms | 60fps / 34ms | 59fps / 54ms | 44fps / 83ms |

Quadrupling the data per agent barely moved anything; going from 32 to 48 panes cost a third of the frame rate at both rates.
Generators achieved 100% of their target rate in every paced run, so Fleet never fell behind on throughput at all - it degraded on per-pane fixed overhead.

The practical read: at a realistic 200 KB/s per agent, ~32 simultaneously **visible** panes stay at ~60fps, and the knee is somewhere past 32.
Hidden panes are cheaper still (they coalesce to 250ms in `use-terminal.ts`) and were not measured here.

## Two things that bite when measuring this

**`LOG_LEVEL` defaults to `debug` whenever Electron is unpackaged.**
`logger.ts` derives it from `app.isPackaged`, so under `npm run dev` every backpressure pause and every resume writes a formatted winston line to the console *and* to the daily file.
That is a per-event cost on the hot path in dev only - packaged builds get `info`, and the pty logs are all `debug`.
Any throughput measurement taken in dev without `LOG_LEVEL=info` is measuring winston.

**A tty `drain` event is not a reliable wakeup, and a pending listener does not keep the process alive.**
Two separate traps in one generator.
stdout to a TTY is synchronous on POSIX, so `write()` can return `false` having already flushed - the `drain` then never fires and the writer parks forever.
And a `once('drain')` listener is not a libuv handle, so even a correct drain-based pump exits silently the moment it parks.
Both show up identically: the pane just goes quiet mid-run.
Pace with `setImmediate` and let the blocking write supply the backpressure.

## Latent ordering hazard in `PtyManager` backpressure

`create()`'s overflow handler does this, in this order:

```ts
entry.paused = true;
entry.pausedAt = Date.now();
this.flushPane(opts.paneId);   // invokes the consumer callback SYNCHRONOUSLY
proc.pause();                  // ...and only then pauses
```

If any consumer ever calls `resume()` synchronously from inside that flush callback, the `resume()` is undone by the `pause()` that follows it, while `entry.paused` has been reset to `false`.
`resumeIfStuck` requires `paused === true`, so the 250ms self-heal is not eligible, `flushAll` finds an empty buffer, and the pane is silently dead forever.

Fleet does not hit this today: the real ack is `ptyDrain` over IPC, which is asynchronous, so the `resume()` always lands after the `pause()`.
The hazard is that the safety depends entirely on that asynchrony, and nothing in `pty-manager.ts` says so.
Cost me a debugging cycle when the benchmark's in-process consumer acked synchronously.
Either pause before flushing, or note the requirement where the pause is applied.

## Measured against Rust, because the first version of this was inference

The first pass of this document argued about Rust without measuring any.
So: identical 64 MB byte corpora fed into `alacritty_terminal` 0.26 (the crate Alacritty and Zed's terminal are built on) and into `@xterm/headless` 5.5 - the same parser and buffer Fleet ships, with the renderer removed so both sides are parse-into-grid and nothing else.
Both at 80x24 with 3000 lines of scrollback, release build, three iterations, mean MB/s:

| | scroll 4K | scroll 64K | tui 4K | tui 64K |
| --- | --- | --- | --- | --- |
| rust / alacritty_terminal | 171.4 | 179.1 | 214.7 | 215.8 |
| js / xterm (flow-controlled) | 79.2 | 74.9 | 94.5 | 95.1 |
| js / xterm (await each chunk) | 2.9 | 21.2 | 4.4 | 37.3 |

Rust is **2.2-2.3x** faster at parsing. Not 10x, not 100x.

Peak RSS for N terminals each filled to a full 3000-line scrollback, same corpus, `/usr/bin/time -l`:

| terminals | rust | node |
| --- | --- | --- |
| 0 (floor, includes the 64 MB corpus) | 66 MB | 183 MB |
| 8 | 114 | 300 |
| 16 | 163 | 346 |
| 32 | 260 | 479 |

Slope: **~6.1 MB per terminal in Rust, ~7.5 MB in JS.** About 1.2-1.5x.

That last number corrects a wrong assumption worth naming: xterm.js does **not** store cells as JS objects.
Its `BufferLine` packs three `Uint32`s per cell into a typed array, so it is already within spitting distance of `alacritty_terminal`'s ~20-24 byte `Cell`.
Any argument that a Rust grid would cut terminal memory by an order of magnitude is simply false, and the 1-2 GB heap seen under load was transient garbage rather than cell storage.

Two things that do favour Rust and are not throughput: there is no 4 GB V8 heap ceiling, and steady-state garbage per byte delivered is zero.

The `await each chunk` row is the most actionable finding here.
It is 7-25x slower than the flow-controlled row, and the gap closes as the chunk grows - 2.9 MB/s at 4 KB chunks against 21.2 MB/s at 64 KB on the same bytes.
The cost is the per-callback round trip, not the parse.
Fleet writes one batch per pane per 16ms flush and awaits the callback to send its drain ack, so a pane that has fallen behind drains at a rate governed by callback round trips.
Coalescing into fewer, larger writes when a pane is backed up is worth more than any parser change.

## xterm.js throws away data past 50 MB pending

`WriteBuffer.write` starts with `if (this._pendingData > 5e7) throw new Error('write data discarded, use flow control to avoid losing data')`.
Hit while writing the benchmark, by pushing a corpus in without honouring flow control.

Fleet is a well-behaved consumer - one write per flush, drain ack on the callback - so this needs a pane whose renderer has been stalled for tens of seconds while output keeps arriving before 50 MB could pile up in one terminal.
Two things make it worth writing down anyway.
`writeToTerm` in `use-terminal.ts` does not wrap `term.write` in a try/catch, so if it ever did throw, the throw lands in an IPC event handler.
And `RESUME_WITHOUT_DRAIN_MS` deliberately resumes a paused PTY *without* the renderer having acknowledged anything, which is the one mechanism in the system that can keep feeding a renderer that is not keeping up.
Not reproduced in Fleet itself - only in a harness that deliberately broke the contract.

## Garbage, not a leak

Under 16 streaming panes the renderer's JS heap climbed to 1.17 GB, and to 2.32 GB shortly after the load stopped, with total Electron RSS at 4.6 GB against V8's 4 GB heap limit.
It is transient: 35 seconds idle brought the heap back to 90 MB and RSS to 1.3 GB.
V8 simply never got the idle time to collect while the panes were streaming.

Worth knowing for two reasons.
The 4 GB V8 limit is a real ceiling that sustained many-pane streaming moves toward, and the garbage is generated per byte delivered - strings per flush, a structured-clone copy per IPC hop, per-cell objects in the parser.
Reducing it is a matter of transferring bytes as `ArrayBuffer` rather than strings and not concatenating, which is ordinary JS work rather than a substrate change.
