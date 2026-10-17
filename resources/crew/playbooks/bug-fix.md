---
name: bug-fix
description: A bug with a clear report - reproduce, fix with a test, review.
steps:
  - { id: fix, role: builder }
  - { id: review, role: reviewer, after: [fix], workspace: { of: fix } }
---
For a bug the report describes well enough to reproduce.
The builder reproduces the bug first, writes a test that fails, then fixes it.
Add a qa step after review when the bug is in the UI.
