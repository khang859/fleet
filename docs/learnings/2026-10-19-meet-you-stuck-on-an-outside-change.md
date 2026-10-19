# Meet you got stuck on a client file changed outside Fleet

## What happened

The client answered a Meet you question, and the next one failed with "This file changed outside Fleet. Keep or undo that change in Settings first."
The project's client file in `~/.fleet/agency/clients/` had been deleted outside Fleet, while `client_files` still held the version Fleet last wrote.
`ClientFiles.changedOutside` compares the file on disk with that mark, so a deleted file counts as an outside change, and every answer for that layer was refused.

Three things made it a dead end:

- Meet you showed only the red refusal, with no way to settle the change.
- Settings had only "Keep this version"; nothing could undo a change, though the refusal said "Keep or undo".
- The side panel showed "Nothing yet." or stale lines, with no sign that the file had changed.

## Fix

- `ClientFiles.undo(layer)` writes Fleet's last version back, through `undoClientFile` on IPC and preload.
- `OutsideChange` (`src/renderer/src/components/settings/OutsideChange.tsx`) offers "Keep the change" and "Undo it", in Settings and in Meet you.
- Meet you reads `changedOutside` for both layers, holds the question's picks while its layer changed, shows the notice above the composer, and marks the layer in the side panel.
  A refused answer reads the layers again, so a change made mid-flow shows too.

## Lesson

Every refusal the client can hit needs a way out on the same screen, and its text must name only actions that exist.
Reproduce such a bug E2E with a throwaway repository: its project questions write only to its own client file, so deleting that file is safe.
