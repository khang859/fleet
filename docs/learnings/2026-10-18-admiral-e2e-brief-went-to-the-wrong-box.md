# Admiral E2E: a brief went to the wrong box, twice

## What happened

In the Phase 5 E2E run, two briefs did not reach the Bridge.

1. Settings was open over the Admiral pane.
   I pressed Escape to close it, then typed the brief.
   Escape does not close Settings, so the text went nowhere, and the brief was lost.
2. Later, a click on the **Bridge** tab did not land, and the job tab for j2 stayed in front.
   The brief went into j2's thread ("Message the Admiral…") as a message, not a new job.
   The Admiral said it could not open a second job from inside a job tab.

## Fix

- To leave Settings, click the Admiral's entry in the sidebar (`text=Admiral · <project>`), not Escape.
- Before typing a brief, check the box is the Bridge's: `textarea[placeholder="Brief the Admiral…"]:visible`.
  A job thread's box says "Message the Admiral…".
- Take a screenshot after the tab click and before the brief, so a missed click shows at once.

## Rule

In a drive script, check where the focus is before you type.
A typed step that lands in the wrong box fails without an error.
