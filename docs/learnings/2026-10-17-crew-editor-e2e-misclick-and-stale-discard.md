# Crew editor E2E: a missed click saved the wrong role, and Discard kept a stale file

## What happened

Two problems came up while testing Settings › Agency › Crew in the dev app.

First, a fleet-drive script ran its steps with `;` between them.
A hot reload had moved the selection to Architect, so the click on the test role failed.
The next steps still ran: they typed into Architect and pressed Save.
That wrote `~/.fleet/crew/roles/architect.md`, a real user file, and made the folder too.
The file was found and removed at once, since the folder did not exist before.

Second, the editor refused a save because the file had changed outside Fleet, and said "Discard, then edit it again."
Discard only dropped the draft.
The page still held the old file text, so every new edit was refused again.

## Fix

Discard now reads the crew files again (`onDiscard` in `AgencyCrewSection`), so the editor shows the file as it is now.
The E2E run checks this: change the file outside Fleet, edit, Save (refused), Discard, edit, Save (works).

## Rule

Chain fleet-drive steps with `&&` whenever a later step writes something, like Save.
Scope a selector to the region you mean, for example `role=region[name="Role e2e-tester"] >> role=button[name="Save"]`.
After a hot reload, check the selection before you edit.
A message that tells the user to discard must make Discard load fresh data.
