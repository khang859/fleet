---
name: launch
description: Launch a feature - strategy, copy and visuals, then an edit pass.
steps:
  - { id: strategy, role: strategist, gate: client }
  - { id: copy, role: copywriter, after: [strategy] }
  - { id: visuals, role: designer, after: [strategy] }
  - { id: edit, role: editor, after: [copy, visuals], workspace: { integrate: [copy, visuals] } }
---
For telling people about something that shipped.
The client sees the strategy before the copy and visuals start.
The editor works on the merged copy and visuals, so the pieces read as one.
