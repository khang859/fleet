# Pi session tracking

## Pi writes its session file late

Pi reports a session file path at `session_start`, but it creates the file only after the first prompt.
`ConversationReader.watch` returned early for a missing file, so the copilot chat of a new Pi session never updated.
The fix: the reader keeps such a session in `waitingForFile`, and starts its watcher on the next registry change that finds the file.

## A session id is not a path for Pi

Pi names a file `<time>_<id>.jsonl`, so Fleet cannot build the path from the id as it does for Claude Code.
Live sessions use the path from the event, and the Sessions view uses a map from the last listing.

## Pi entries are a tree

`/tree` goes back to an earlier entry and continues from it in the same file.
Reading the file top to bottom shows every branch.
`PiMessageTail` walks `parentId` from the last entry, so entries with no message must still join the chain.
Spend counts every branch, because leaving a branch does not refund it.

## Fake model for E2E tests

Pi can run against a local OpenAI-style server through `pi.registerProvider` in an extension.
That gives a real Pi with tools, cost and dialogs, with no provider account.
Set `PI_CODING_AGENT_DIR` to a throwaway folder to test extension discovery without touching `~/.pi/agent`.
Read the session id after Pi prints its footer, because a slow start can send `SessionStart` late.

## Test isolation

A test that uses `SessionsService` must mock `pi-source` too, or it reads the real `~/.pi/agent/sessions`.

## `npm run format` covers the whole repo

It rewrote 79 unrelated files in this work, because many files are not in Prettier style.
Format only what a change touched: `npx prettier --write <files>`.
