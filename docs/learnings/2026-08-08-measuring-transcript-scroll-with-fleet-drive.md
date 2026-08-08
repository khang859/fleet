# Measuring transcript scroll drift with fleet-drive

While adding folded tool-call groups to the Agent pane, the open question was whether collapsing several rows into one mid-stream yanks the transcript under a reader who has scrolled up.
Answering it took three attempts, and the first two produced confident-looking numbers that meant nothing.

## What went wrong

**Picking the scroll container by measurement.** The first probe chose its scroll box by scanning for the element with the largest `scrollHeight`.
That finds a tool row's `<pre>` output block or a diff body - both are `overflow-auto` with a `max-h` - long before it finds the transcript.
The probe then dutifully reported that "the container" never grew during a streaming turn, which was true of the block it had picked and irrelevant to the question.

The transcript scroller is the element carrying `fleet-scroll-balanced` (`AgentThread.tsx`, the `scrollRef` div).
Select it by that class, not by measuring.

**Scrolling up and then sending the prompt.** The second probe parked the reader 700px from the bottom, then submitted a message to trigger the sweep.
Sending a message scrolls the transcript to the end - correctly, it is your own message - so every run showed a large "drift" that was just the pane doing the right thing.
The reader has to be parked *after* the turn is already underway, which means the sampler and the prompt submission have to be interleaved rather than run in sequence.

## What worked

Submit the prompt first, then start an in-page sampler that waits ~2.5s before parking the scroll position and taking its landmark.
Watch a landmark element's `getBoundingClientRect().top` rather than `scrollTop` alone, since content growth and scroll movement are separable and only their combination tells you whether the reader's view moved.

Then A/B it. `git stash`, let Vite hot-reload the renderer, re-run the identical probe, `git stash pop`.
Without the baseline the number is unattributable: the measurement here came back at -727px with grouping and -864px without it, which turned a suspected regression into a pre-existing behavior that the change slightly reduces.

## The other half: sampling rate

Polling from the CLI (`npm run drive -- eval ...` in a loop) samples about once per second, which never catches a `read` tool call in flight - they finish in tens of milliseconds.
A transient UI state has to be sampled from inside the page, with a `setTimeout` loop at 40-60ms accumulating into a `Set`, and the promise resolved at the end.
Even then, `read` is too fast to catch reliably; `grep` over the whole repo is slow enough to land in the sample window.

A related trap: reading an attribute in the same tick as the `click()` that changes it returns the pre-render value.
The sampler recorded `aria-expanded=false` immediately after opening a group, which looked like the click had failed and was only React not having re-rendered yet.
Dedupe consecutive identical samples and read the state on a later tick.
