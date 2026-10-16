# Sessions list re-parsed whole transcripts on every Claude write (#648)

## What happened

A user on Linux reported keyboard lag with Fleet's main thread at 99.9% CPU for minutes, with 2 Claude Code sessions open.
The Sessions list did the work, not the PTY path.

- `SessionsService` watched `~/.claude/projects` with `recursive: true` and sent `SESSIONS_CHANGED` 500 ms after any write.
- The always-mounted `SessionsTabCard` answered each one with `sessions.list()`, whether the Sessions tab was visible or not.
- `listClaudeSessions` cached summaries by mtime and size, but a transcript Claude is writing changes on every line.
- So each refresh read the whole active transcript, split it, JSON-parsed every line twice, and streamed every subagent transcript from byte 0.
- Transcripts only grow, so the cost grew with uptime.
- On Linux, Node runs `recursive` watching in JS, with a watcher per subdirectory, which added more load.

A repro with one 53 MB transcript plus 40 MB of subagent files, and a line appended about once a second, measured 58% of a core and a 305 ms event-loop stall per refresh.

## Fix

- `SessionTail` and `JsonlTail` (`src/main/claude-sessions/session-tail.ts`) follow a session's transcript and subagent files, and read only the bytes added since the last read.
- `SummaryTail` in `src/main/sessions/claude-source.ts` keeps running totals (message count, preview, cwd, usage), never the messages.
- The open transcript in the Sessions tab is followed with `MessageTail`, and the renderer re-reads it only when its `updatedAt` changed.
- `listClaudeSessions` and `readClaudeSession` take turns, because they share the tails.
- `SessionsService.list` folds calls made during a list into one follow-up list.
- `ProjectsWatcher` watches the projects dir and each project dir, not recursively, and ignores files other than `.jsonl`.
- Its debounce has a 2 s cap, so an agent that writes without pause still refreshes the list.

After the fix, the same repro measured 1.1% of a core, 6 ms per refresh, and no stall above the idle baseline.

## Lessons

- A cache keyed on mtime and size does nothing for the one file that is changing, and that file is usually the largest.
- For a file that only grows, keep a byte offset and running totals; `SessionUsageTracker` and `TranscriptTail` already did this, so reuse them before writing a whole-file parser.
- Anything a watcher triggers needs a cost that does not grow with the data, and at most one run in flight.
- Avoid `fs.watch(..., { recursive: true })` on big trees: on Linux it is a JS emulation with a watcher per directory.
- On macOS, a new `fs.watch` can report changes made just before it started; tests that expect silence must let those pass first.
