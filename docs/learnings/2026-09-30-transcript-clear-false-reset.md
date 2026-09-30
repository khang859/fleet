# The copilot chat emptied itself when a transcript quoted `/clear`

Found while rebuilding `src/main/copilot/conversation-reader.ts` on the shared transcript normalizer (`src/main/claude-sessions/transcript.ts`).

## What happened

The reader treated any transcript line containing `<command-name>/clear</command-name>` as a `/clear`, and dropped every message before it.
The check ran on the raw line, before looking at who wrote it.
A tool result, an assistant message or a pasted prompt that merely quoted the tag reset the chat.
One real session on this machine read as 5 messages instead of 1100, because a `grep` over transcripts printed the tag into a tool result.

The reader also lost a line cut in half by a read: it split whatever bytes were on disk on newlines and dropped the unfinished last line for good, since the next read started after it.

## How it was fixed

- `normalizeLine` only reports `clear` for a user line whose prompt text holds the tag, which is how Claude Code 2.1.285 writes the command.
- `TranscriptTail` splits on newline bytes and keeps an unfinished last line until the rest arrives, so offsets are exact and no line is lost.
- The reader, the session brief and the Orchestrator's reads all use the same normalizer, so they cannot disagree about what a transcript says.

## How it was checked

The old and new parsers were run over every transcript under `~/.claude/projects` (72 files).
They agreed on all but that one session, apart from an intended fix to the `TaskStop` preview, which now reads `task_id`.
A golden fixture (`src/main/claude-sessions/__tests__/fixtures/turns.jsonl`) pins both the events and the chat messages, and the old reader produced the same messages for it.

## Takeaways

- Match a marker where it is written, not anywhere in the line: transcripts routinely contain other transcripts.
- When replacing a parser, diff the old and new output over real data before trusting the tests.
