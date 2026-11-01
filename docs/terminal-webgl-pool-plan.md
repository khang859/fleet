# WebGL pool for visible terminal panes

**State:** rejected for now. A shared 250 ms paint tick was built instead. See "Spike: text and solid backgrounds" and "What was built" under Review and results.
**Date:** 2026-11-01
**Written against:** `8c94695d`.
All line numbers below are pinned to that commit. Re-grep before trusting one.
**Origin:** the part of #716 that #742 did not fix, and the WebGL idea in #734.
**Handoff:** not written. Write one if another session picks this up.

## What this is

Agent panes still redraw every row, about 10 times each second, while a spinner runs.
#742 fixed this for a plain shell, but not for Claude Code or pi.
xterm itself asks for the full redraw in those panes, for reasons Fleet does not control.
`docs/learnings/2026-11-01-agent-panes-redraw-all-rows.md` has the cause.

The cost grows with each visible agent pane, and many visible agent panes is the main use of Fleet.
One spinner adds about 8% of one core to the whole app.
At 16 panes that is about 128% of one core, if the cost grows in a straight line.
That total is an estimate, because only one pane was measured.

## Goals and non-goals

Goals:

- Cut the drawing cost of visible agent panes by at least half, measured at 8 panes.
- Any WebGL failure must end in a working DOM pane, with no lost content.
- After a context loss, a pane may look stale or blank for about 3 seconds, and no longer. Prior art explains why.
- Close #716, and finish the WebGL part of #734.

Non-goals:

- No user setting for the renderer. Add one only if a real GPU problem appears.
- No change to how hidden panes buffer output.
- No WebGL for hidden panes.
- No change to PTY flow control or any main-process code.
- No fork or patch of xterm.

## Measurements

One visible pane, 38 rows, dev build, `LOG_LEVEL=info`.
The app was restarted before each mode.
The spinner is a script with Claude Code's byte shape.
It gives 384 rows/s, and the real agent gives 391 rows/s.

| Mode                        | Renderer main thread | Whole app, GPU included |
| --------------------------- | -------------------- | ----------------------- |
| Idle                        | 2.6%                 | 8-9%                    |
| DOM renderer, today         | 6.1-6.5%             | 15-17%                  |
| DOM, unchanged rows skipped | 5.2%                 | 14%                     |
| WebGL addon 0.19.0          | 2.4%                 | 10%                     |

The numbers are noisy, and samples just after a restart were dropped.
The row-skip line rests on one settled sample.
Treat these as sizes, not exact values.

## Review and results

Three adversarial reviews and an 8-pane test changed this plan.
The sections after this one are the old plan, kept for the reasoning, and they do not include these changes.

Problems confirmed against the source, npm and the xterm tracker:

- `WebglAddon.dispose()` in 0.19.0 does not free the context, so the 12-slot limit does not hold. PR 6069 fixes this, in beta only at this date.
- After a real GPU reset, panes that share a letter sheet can stay blank, and `onContextLoss` should not fire (#6257, open).
- WebGL floors cell width and DOM does not, so a renderer swap can change the column count (#6264, open).
- Dim and italic cells can get opaque boxes on transparent backgrounds (#6116, open).
- `allowTransparency: true` can thin text (#4212, open), and Fleet always sets it.

Measured on 2026-11-01, as the measurement procedure says, with no pool and no `contain: strict`.
8 visible panes at 29x19, one focused, dev build, xterm 6.1.0-beta.336 and addon-webgl 0.20.0-beta.329.
The throttle mode writes each unfocused pane at most every 250 ms.

| Mode           | Whole app | Renderer main thread | GPU busy, whole machine |
| -------------- | --------- | -------------------- | ----------------------- |
| Idle           | 7.4%      | 2.6%                 | 0.8%                    |
| DOM, first run | 53.4%     | 13.5%                | 13.9%                   |
| WebGL          | 24.6%     | 5.3%                 | 5.1%                    |
| Throttle       | 35.5%     | 10.5%                | 10.0%                   |
| DOM, last run  | 55.5%     | 14.4%                | 14.1%                   |

This table first looked like a 63% whole-app gain for WebGL.
The repeat runs below show that this number was too high, so do not quote it.

### Repeat runs: whole-app CPU is noisy

Measured later on 2026-11-01, with the same setup, on the same beta versions.
Each row is the median of one run, in run order.
Idle was 7.6% whole app, 2.7% renderer main thread and 1.7% GPU process.

| Mode  | Whole app | Renderer main thread | Renderer process, all threads | GPU process |
| ----- | --------- | -------------------- | ----------------------------- | ----------- |
| DOM   | 25.7%     | 12.7%                | 17.7%                         | 5.4%        |
| WebGL | 26.1%     | 5.6%                 | 10.5%                         | 12.3%       |
| DOM   | 39.1%     | 18.0%                | 26.6%                         | 9.7%        |
| WebGL | 34.2%     | 8.0%                 | 14.1%                         | 15.0%       |
| DOM   | 51.8%     | 18.7%                | 37.6%                         | 10.8%       |
| WebGL | 28.4%     | 5.4%                 | 10.2%                         | 14.0%       |

Taking the median of the three runs of each mode, and removing idle:

- Whole app fell 34%, and the pairs in run order ranged from no gain to 53%.
- Renderer main thread fell 81%.
- Renderer process fell 73%.
- GPU process rose 54%, so some of the cost does move there.

Pooling all 5 beta DOM runs and all 4 WebGL runs gives a 56% whole-app gain.
That mixes sessions, so the honest range is about 35% to 55%.
The 50% goal is therefore not proven on whole-app CPU.

DOM whole-app CPU ranged from 26% to 60% over 12 runs.
In one set, it moved from 33% to 58% while the main thread stayed at 13-14%.
The swing is mostly in renderer threads other than the main thread, and the cause is unknown.
WebGL ranged only from 25% to 34% over 4 runs, so steadier cost is a real gain.
The machine-wide GPU counter is not reliable either, because it read 14.9% at idle in one session.
The two whole-machine counters changed mid-session, so something else on the machine was active.
Memory and battery were not measured.

### Shared paint tick

This test put unfocused panes on one shared timer, so that they paint in the same frame.
It ran on xterm 6.0.0, over 2 or 3 runs of each mode.
Saved is spinner cost on the renderer main thread, with idle at 2.4%.

| Mode                   | Frames/s | Renderer main thread | Saved |
| ---------------------- | -------- | -------------------- | ----- |
| DOM                    | 38-47    | 13.0-13.9%           | none  |
| Shared tick, 100 ms    | 17       | 11.6-13.2%           | 10%   |
| Per-pane timer, 250 ms | 21-24    | 9.6-10.8%            | 30%   |
| Shared tick, 250 ms    | 12-14    | 9.0-9.7%             | 37%   |

Aligning frames cut the frame count by more than half, but it saved little.
100 ms did not come close to 250 ms, so a tick has no free gain with no choppy panes.
Whole-app CPU failed the 20% rule on these runs too, so it is not used here.
The tick can return as a small extra on top of WebGL if a later measurement needs it.

### Decision

Use WebGL, on `@xterm/xterm` 6.1.0-beta.336 and `@xterm/addon-webgl` 0.20.0-beta.329, pinned to exact versions.
The other xterm addons must move to matching beta versions.
The reasons are the large main thread gain, the steadier total, and the proven DOM fallback in other apps.
The gain is real, but it is smaller than first reported, and part of it moves to the GPU process.
The pool design below still needs a revision for these results and for the reviews.

The measurement rule changes for the final gate, because DOM cannot pass the 20% rule on whole-app CPU.
The final gate uses 5 DOM and 5 WebGL runs, in turn, with no other work on the machine.
It reports the median of each mode, and the renderer main thread and the GPU process as well as whole-app CPU.

### Spike: text and solid backgrounds

All earlier 8-pane runs had a background picture on in the dev sandbox, so all panes were transparent.

Text on a picture fails on the pinned beta.
Bold, dim, italic and underlined cells get opaque black boxes (#6116).
The cause is `$a = 1` in `RectangleRenderer.ts`, because those cells carry flags in their background value, so a default background rectangle is drawn at full alpha.
Setting `allowTransparency: false` does not fix it, and it makes inverse text disappear.
No public API avoids this, so picture panes stay on DOM unless xterm gets a fix.

Text on a solid background passes.
It shows no boxes and no thin text, and emoji, CJK and box characters draw correctly.
The cell width falls from 8.4 to 8 CSS pixels, so text is about 5% narrower and a refit is required (#6264).

Solid background, 8 panes, 3 runs of each mode, medians over idle.
Idle was 9.1% whole app, 3.1% main thread, 2.2% GPU process and 2.6% WindowServer.

| Metric                        | DOM   | WebGL | Change        |
| ----------------------------- | ----- | ----- | ------------- |
| Whole app                     | 42.2% | 32.0% | 31% less      |
| Renderer main thread          | 18.1% | 6.4%  | 78% less      |
| Renderer process, all threads | 27.2% | 12.3% | 67% less      |
| GPU process                   | 9.7%  | 15.8% | 81% more      |
| WindowServer                  | 14.9% | 25.0% | 82% more      |
| GPU chip busy                 | 8.5%  | 0.6%  | 93% less      |
| Whole app plus WindowServer   | 57.1% | 57.0% | no change     |
| Memory, sum of RSS            | 1004  | 822   | no clear gain |

The two A runs of DOM differ by less than 20% here, so this set passes the old rule.
WebGL misses the 50% goal on whole-app CPU.
WindowServer takes back the whole gain on CPU, so total machine CPU does not change.
The real gains are a free main thread and a much less busy GPU chip.
Memory numbers overlap between modes, so they show no clear change.

This changes the shared tick result too.
At 250 ms, its whole-app runs on a picture were 34.0%, 22.4% and 25.5%.
That is as low as WebGL on the same background, and it does not need a beta or a pool.
Its WindowServer cost is not known, because those runs had other activity on the machine.
Its cost is that unfocused panes update only 4 times per second.

### What was built

Visible panes without focus now use the same deferred output path as hidden panes, and all panes share one 250 ms tick.
`src/renderer/src/lib/terminal-paint-tick.ts` holds the tick, and `src/renderer/src/hooks/use-terminal.ts` uses it.
The focused pane still writes at once.
A pane writes its deferred output at once when it takes focus or becomes visible.
A pane holds at most 1 MiB, and past that its output takes the normal path with real backpressure.

A flush can end inside a DEC 2026 frame.
xterm then skips that paint, and the next flush repairs it, so no frame code was added.
This could stall only if every flush ended inside a frame.
A live test of 30 synchronized frames per second in an unfocused pane painted 3.6 times per second.

Picture background, 8 panes at 29x19, 3 runs of each mode, old and new in turn in one session.
Idle was 9.3% whole app, 3.2% main thread, 2.3% GPU process and 5.6% WindowServer.

| Metric                      | Old   | New   | Spinner cost change |
| --------------------------- | ----- | ----- | ------------------- |
| Whole app                   | 51.1% | 30.6% | 49% less            |
| Renderer main thread        | 18.4% | 12.3% | 40% less            |
| GPU process                 | 10.8% | 5.2%  | 66% less            |
| WindowServer                | 12.7% | 7.1%  | 79% less            |
| Whole app plus WindowServer | 63.8% | 37.7% | 53% less            |
| GPU chip busy               | 12.2% | 4.9%  | 60% less            |
| Frames/s                    | 38    | 13    | 66% less            |

Old whole-app runs were 51.1%, 67.7% and 47.3%, so the old path fails the 20% rule again.
New whole-app runs were 30.6%, 30.0% and 30.8%, so the new path is steady.
Unlike WebGL, this cuts WindowServer too, so total machine CPU falls.
Solid backgrounds were not measured for this change.
A real agent spinner was not measured either, because the fake spinner has the same byte shape.

## Prior art

The addon README says the browser can drop a context after a suspend or when memory runs out.
It suggests calling `addon.dispose()` in `onContextLoss`.
The xterm source shows that disposing the addon swaps the terminal back to the DOM renderer and leaves the buffer alone.
This is the fact that makes a pool safe: a pane can change renderer at any time without losing content.

`onContextLoss` does not fire at the moment of loss.
`WebglRenderer` waits 3 seconds for the browser to restore the context, and it fires only if that fails.
The pool never hears about a restored context, and xterm #6257 says panes with the same font and theme can stay blank after a real GPU reset.

VS Code uses the same addon with a DOM fallback.
That is from memory and was not checked again for this plan.

What does not transfer: most apps that use this addon show one or a few terminals.
Fleet can show more panes than Chromium allows contexts, so Fleet needs a limit.

## Locked requirements

Do not reopen these. If you think one is wrong, say so and stop.

1. DOM stays as the fallback, and it must always work.
2. Hidden panes hold no WebGL context.
3. Only public xterm API is used, with no `_core` access.
4. The change ships only if the 8-pane measurement meets the goal.

These are proposed and become locked when this plan is approved.

## What already exists

| What is needed                       | What already does it                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Know when a pane shows or hides      | `IntersectionObserver` at `src/renderer/src/hooks/use-terminal.ts:517`               |
| One place to load addons             | `createTerminal`, `use-terminal.ts:332-336`                                          |
| One place to tear down               | The effect cleanup, `use-terminal.ts:998-1010`                                       |
| Transparent background               | `allowTransparency: true`, `use-terminal.ts:316`                                     |
| Repaint on return from hidden        | `term.refresh`, `use-terminal.ts:1079`                                               |
| Swap renderer without losing content | `WebglAddon.dispose()` in xterm                                                      |
| Free a context on dispose            | `@xterm/addon-webgl` 0.20.0-beta.329 with core 6.1.0-beta.336, which include PR 6069 |

## Alternatives considered

**Stop at #742.**
This costs nothing and adds no risk.
It lost because agent panes are the main use of Fleet, and they got almost no gain from #742.

**Skip unchanged rows in the DOM renderer.**
Rejected outright.
A prototype cut rebuilt rows by 35 times, but CPU fell only about a quarter of the spinner's cost.
It also needs private fields such as `_core._renderService._renderer`.
It must also track the cursor, selection, decorations, theme and focus, or it shows stale rows.
So the gain is small and the failure is silent wrong output.

**Fix it in xterm upstream.**
This has the same small gain as the row skip, because most of the cost is not in rebuilding rows.

**WebGL for all panes, with no limit.**
Rejected outright.
Past the Chromium limit, the browser drops the oldest context by itself.
Fleet would then get context loss in normal use, and panes would change renderer at random.

**Keep contexts for recently hidden panes.**
This could make tab switches faster, but it adds eviction rules.
It is left out until step 4 shows that a tab switch needs it.

## The chosen architecture

### 1. A small pool module (`author's call`)

`src/renderer/src/lib/terminal-webgl-pool.ts` holds the slots.
It takes `acquire(paneId, { term, isVisible })` and `release(paneId)`.
It holds no React state and knows nothing about tabs.

### 2. Limit of 12 slots (`author's call`)

Chromium allows about 16 contexts per page.
That number is from memory, and step 3 confirms it.
No other code in `src` creates a WebGL context at this commit, so 12 is a safety margin, not a share with other users.

### 3. Visibility drives slots (`locked`, from requirement 2)

The observer at `use-terminal.ts:517` calls `acquire` when the pane shows and `release` when it hides.
A pane with no free slot stays on DOM and joins a waiting list.
When a slot frees up, the oldest waiting pane gets it.

The observer callbacks do not tell the pool the truth at the right time.
Each pane has its own observer, and the callbacks run one after another in no set order.
On a tab switch, a slot can free up before a hidden waiter's own hide callback runs.
The pool would then give a context to a hidden pane, which breaks requirement 2.

So the pool never trusts its list.
`isVisible` is `() => container.checkVisibility()`, which reads the real DOM state.
The pool calls it in `acquire`, and again for each waiter just before promotion.
A waiter that is not visible leaves the list, and it joins again on its next show.
A detached container also reads as not visible, so a queued callback that runs after teardown does nothing.
`release` for a pane with no slot does nothing, so a late hide callback is safe.

### 4. Failed activation (`locked`, from requirement 1)

Most failures should never reach the terminal.
On the first `acquire`, the pool makes one test `webgl2` context on a throwaway canvas, then frees it with `WEBGL_lose_context`.
If that fails, the pool goes off for the session and no addon is created.

A later throw inside `loadAddon` needs a real rollback, for two reasons found in the xterm source.
`AddonManager` adds the addon to its list before it calls `activate`, so a failed addon stays registered.
`WebglRenderer` appends its canvas and registers listeners before it builds its shaders.
If a shader fails, the addon never gets a reference to that half-built renderer, so `addon.dispose()` cannot clean it up.
This half-built state was read from the source and has not been run yet.

The rollback in the pool is:

1. Record the canvases in `.xterm-screen` before `loadAddon`.
2. On a throw, call `addon.dispose()`, which removes it from `AddonManager`.
3. Remove any canvas that was not in the record.
4. Call `term.refresh(0, term.rows - 1)`.
5. Turn the pool off for the session, so the leak can happen at most once.

The half-built renderer's theme and option listeners stay alive after this.
Step 5 must prove that a later theme change and `term.dispose()` are safe.

### 5. Context loss (`locked` for suspension, `author's call` for the numbers)

A loss can mean the whole GPU reset, not one bad pane.
Promoting a waiter at once would then feed more panes into the failure, one after another.
So a loss stops new contexts for a time, across the pool.

The pool has 3 states: on, suspended and off.

- On any `onContextLoss`, the pool disposes that addon, frees its slot, and suspends for 30 seconds.
- While suspended, it creates no context and promotes no waiter. Panes that show or lose a context join the waiting list.
- A loss during a suspension restarts the 30 seconds and counts as the same episode. So 12 panes lost at once are one episode.
- When the time ends, the pool goes back to on and promotes waiters, with the same visibility check.
- After 3 episodes in 10 minutes, the pool goes off until restart. Panes still holding a context keep it.

Events can arrive late, because of the 3-second wait.
Each `acquire` makes a new lease, and an event from a released lease does nothing.

### 6. Teardown order (`locked`, from #734)

The cleanup calls `release` before `term.dispose()`.

### 7. `contain: strict` on the terminal container (`author's call`)

This comes from #734 and is a separate, small change.
It ships first and gets its own measurement.
DOM panes past the limit gain from it too.

## Call-site audit

| Site                                           | Change?   | Why                                                                                                                                                        |
| ---------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use-terminal.ts:517` visibility observer      | Yes       | Calls `acquire` and `release`                                                                                                                              |
| `use-terminal.ts:522-526` `ipcCleanup`         | No        | It disconnects the observer, and a queued callback is safe because `isVisible` reads false                                                                 |
| `src/main/index.ts:555` single-instance lock   | No        | It only shapes how the packaged check runs in step 7                                                                                                       |
| `use-terminal.ts:1010` `term.dispose()`        | Yes       | `release` goes before it                                                                                                                                   |
| `use-terminal.ts:316` comment                  | Yes       | It says the cost is about the DOM renderer only                                                                                                            |
| `src/renderer/src/index.css`                   | Yes       | Adds `contain: strict`                                                                                                                                     |
| `package.json`                                 | Yes       | Pins core and all xterm addons to matching beta versions                                                                                                   |
| `use-terminal.ts:378` `.xterm-screen` listener | No        | This element stays in place with WebGL. Step 3 confirms it.                                                                                                |
| `use-terminal.ts:1024-1036` font change        | Test only | The atlas must rebuild                                                                                                                                     |
| `use-terminal.ts:1058` theme change            | Test only | The atlas must rebuild                                                                                                                                     |
| `use-terminal.ts:1088-1090` search             | Test only | Match highlights must show                                                                                                                                 |
| `use-terminal.ts:336` image addon              | Test only | Not tested with WebGL yet                                                                                                                                  |
| `use-terminal.ts:404` cursor suppression       | Test only | Set through public options                                                                                                                                 |
| `use-terminal.ts:1079` refresh on active       | No        | Public API on any renderer                                                                                                                                 |
| Serialize addon                                | No        | Reads the buffer, not the renderer                                                                                                                         |
| fleet-drive `term` verbs                       | No        | Read the buffer                                                                                                                                            |
| `StrictMode`                                   | No        | No `<StrictMode>` wraps the app at this commit, so the old double-mount error has no live cause. `acquire` and `release` still must be safe to call twice. |

## File manifest

New:

- `src/renderer/src/lib/terminal-webgl-pool.ts`
- `src/renderer/src/lib/__tests__/terminal-webgl-pool.test.ts`
- `scripts/perf/terminal-spinner.mjs`, the fake spinner
- `scripts/perf/terminal-cpu.mts`, the CPU sampler

Changed:

- `src/renderer/src/hooks/use-terminal.ts`
- `src/renderer/src/index.css`
- `package.json` and `package-lock.json`
- `CLAUDE.md`, whose note says no WebGL addon is used
- `docs/learnings/2026-11-01-agent-panes-redraw-all-rows.md`

## Build sequence

1. **Take the 8-pane baseline.**
   Add the two `scripts/perf` tools, and measure mode D from the measurement procedure below.
   Verify: the raw samples and medians are written in this plan before any app code changes.
2. **Ship `contain: strict`.**
   Verify: measure mode C, and check glass backgrounds and the scroll button.
3. **Spike one WebGL pane, before the pool.**
   This settles the parts that can sink the plan.
   Verify each one: images, search highlights, selection, links, font change, theme change, and text sharpness on glass and on a solid theme, next to DOM.
   Confirm the context limit by opening panes until one is lost.
   If text quality or images fail with no fix, stop and report.
4. **Build the pool with tests.**
   Verify: unit tests pass, and a tab switch shows no blank frame or flicker in real use.
5. **Test failure paths in the real app, with the real addon.**
   Force loss with `WEBGL_lose_context` on one pane, then on all panes at once, with panes waiting.
   Make `getContext('webgl2')` return null, which tests the first check.
   Make `getProgramParameter` return false, which fails a shader after the canvas is added.
   Sleep the computer with panes open.
   Verify: each pane keeps its content and takes input on DOM, and no stray canvas stays.
   Verify after the shader failure: a theme change works, and closing the pane logs no error.
   Verify: a pane is back in working order about 3 seconds after loss.
6. **Measure the pool.**
   Measure modes C and W in the same session.
   Verify: the pass rule in the measurement procedure.
   If it does not pass, do not ship the pool.
   `contain: strict` stays, because it was judged on its own in step 2.
7. **Check real agents and a packaged app.**
   Verify: Claude Code and pi panes draw correctly in the dev app.
   `npm run build` proves only that the code compiles, so the packaged check uses a real app:
   1. Run `npm run build:unpack`. It writes `dist/mac-arm64/Fleet.app` on an Apple Silicon Mac.
   2. Quit the installed Fleet first. The single-instance lock at `src/main/index.ts:555` and the shared `~/.fleet` block a second copy.
   3. An agent running inside Fleet cannot do this step, so a person runs it from Terminal.app.
   4. Start `dist/mac-arm64/Fleet.app/Contents/MacOS/Fleet --remote-debugging-port=9333`.
   5. Open a pane, connect a CDP client to port 9333, and read `canvas.getContext('webgl2')` for each canvas in `.xterm-screen`.

   Verify: one canvas in a visible pane returns a context, and the pane accepts input.
   The packaged app does not have `__FLEET__`, so this check must not use it.
   Windows and Linux need the same run from their own `npm run build:unpack`, with a working DOM fallback as the minimum result.

## Measurement procedure

Fix this before step 1, so nobody can pick a method that suits the result.

**Modes.**
D is DOM.
C is DOM with `contain: strict`.
W is C with the WebGL pool.

**Setup, the same for all modes.**

- Same machine, on power, with the same window size.
- 8 visible panes in a 2 by 4 grid, and no other tabs.
- Dev app with `LOG_LEVEL=info`. Write the rows and columns of each pane in the results.
- Load: `scripts/perf/terminal-spinner.mjs` in every pane.
- Idle: the same layout, with each shell at its prompt.

**Run.**

1. Restart the app for each run, and rebuild the layout.
2. Wait 60 seconds. The first samples after a restart were badly skewed by boot work.
3. Start the load, and wait 15 seconds.
4. Take 5 samples of 10 seconds each.
5. Repeat in the order idle, A, B, A, so that drift shows up.

**Metrics.**
The first metric is whole-app CPU, as a percent of one core.
It sums per-process time deltas for the main, renderer, GPU and utility processes.
It excludes the shells and spinners, because they cost the same in all modes.
Deltas are per process, because a total across processes went negative when a process exited.
The second metric is renderer main thread `TaskDuration` from CDP `Performance.getMetrics`.

**Calculation.**
Take the median of the samples in each run.
Spinner cost is the median of the mode minus the median of idle.
If the two A runs differ by more than 20%, discard the set and run it again.

**Pass rules.**
Step 2 compares C with D, and it only reports the gain.
Step 6 compares W with C, measured in the same session, so the pool's own gain is separate from the gain of `contain: strict`.
The pool passes if W's spinner cost is at most half of C's on whole-app CPU, and renderer main thread cost is not higher.

**16 panes.**
Run W at 16 panes too, which gives 12 WebGL and 4 DOM.
This result is for information, and it is not a gate.

## Test plan

Unit tests for the pool, with a fake addon:

- The limit holds, and the next pane waits.
- A release gives the slot to the oldest waiting pane.
- A pane that hides while it waits leaves the list.
- Calling `acquire` or `release` twice does nothing wrong, which guards against the double-mount case.

Callback order, which guards against a context on a hidden pane:

- A slot frees while a waiter is already hidden, and its hide callback has not run. The waiter is skipped.
- Show and hide callbacks arrive in both orders on a tab switch, and all visible panes end with slots.
- A late `release` or `acquire` after teardown does nothing.

Failed activation, with a fake that adds a canvas and listeners and then throws:

- The failed addon is disposed, the new canvas is removed, and the pane refreshes.
- `term.dispose()` after the failure is safe.
- The first check failing means no addon is ever created.
- A throw turns the pool off, which guards against a retry storm.

A fake that throws at once is not enough, because that is the easy case.
The real half-built state is tested in step 5.

Context loss, with fake timers:

- A loss frees the slot, and no waiter gets it during the suspension.
- 12 losses at once are one episode.
- A loss during a suspension restarts the timer.
- After the timer, waiters are promoted, and hidden ones are skipped.
- 3 episodes in 10 minutes turn the pool off, and old episodes age out.
- An event from a released lease does nothing.

Manual checks are in steps 3, 5 and 7, because a unit test cannot see a GPU.

## Baseline to hold

Measured at `8c94695d` on 2026-11-01:

- `npm run typecheck`: no errors.
- `npm run lint`: no errors.
- `npm test`: 368 files, 4847 tests, all passed.

## Known risks

**Text look is the weakest part.**
WebGL draws text on a transparent canvas, and that can change how sharp letters look.
Only one screenshot was checked, on a glass background.
Fleet users look at this text all day, so a small loss matters.
This is why step 3 comes before the pool.

**The gain at many panes is not measured.**
One pane showed a large gain, but GPU cost may not grow the same way.
Step 6 can still end this plan.

**Tab switches may feel worse.**
Each show creates a context and each hide drops it.
The cost of that was not measured.
The letter sheet is shared between terminals with the same font and theme, which should help.

**The 3-second gap after a loss.**
A pane can look stale or blank for that time, and the pool cannot shorten it through public API.
After a sleep, every WebGL pane may do this at once.
Step 5 shows how bad this looks.

**The rollback is not a full cleanup.**
The half-built renderer's listeners stay alive after a failed activation, because public API cannot reach them.
Turning the pool off limits this to one pane.
A throw even later, inside `setRenderer`, is not handled, because the old renderer is already gone.
That throw looks unlikely from reading the code, but it was not tested.

**The suspension numbers are guesses.**
30 seconds, 3 episodes and 10 minutes have no data behind them.
Step 5 can change them.

**More states to reason about.**
A pane can now be on either renderer, and the renderer can change while it runs.
A bug can look like it comes and goes, based on which panes hold slots.

**Other platforms are untested.**
All numbers come from one Mac.
GPU drivers on Windows, Linux and WSL can behave differently.
