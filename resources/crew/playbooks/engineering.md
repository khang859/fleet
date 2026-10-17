---
name: engineering
description: A feature or change across the code - design, build in parallel, integrate, review and test.
steps:
  - { id: design, role: architect, gate: client }
  - { id: build, role: builder, count: 2, after: [design], scopes: [server, client] }
  - { id: integrate, role: builder, after: [build], workspace: { integrate: [build] } }
  - { id: review, role: reviewer, after: [integrate], workspace: { of: integrate } }
  - { id: qa, role: qa, after: [review], workspace: { of: integrate } }
---
For a change big enough to need a design.
The client sees the design before anyone builds.
Use one builder and drop the integrate step when the change has one part; give each builder its own scope when it has two.
The integrate step merges the builders' branches, fixes what conflicts, and opens the PR.
