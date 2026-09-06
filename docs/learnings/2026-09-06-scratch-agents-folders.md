# Scratch in Agents with per-chat folders

- Scratch identity now includes the shared root and its child folders. Keep that predicate in sync in main and renderer; exact root checks would lose the scratch prompt, history grouping, and recent-folder exclusion for new chats.
- Prepare the folder during session loading and persist it alongside the session id. Resume existing transcripts in their recorded folder, including legacy shared-root chats, so file references survive.
- The first type check caught a nullable activity prop on the new Scratch row. `TabStatusIndicator` accepts an optional activity but not `null`; matched the existing component contract.
- Lint also caught an async test mock with no await. Keep the mock async and return `Promise.resolve` explicitly to satisfy both async lint rules, and format newly created files as well as tracked diffs.
- The browser check initially could not write its state inside the sandbox; the approved diagnostic passed, but the saved Fleet debug endpoint was stale (connection refused). Do not assume a saved `.fleet-drive/session.json` means a dev app is running.

## Corrected interaction

The first implementation misread the requested bubble as the Scratch row's icon. The user meant a creation button beside the Agents header's existing plus: every click must open a separate chat. Removed automatic Scratch tab creation and pinning, used ordinary closeable agent rows for conversations, and added the header action. Kept existing Scratch sessions on workspace load and kept their folder behavior.

The new close test initially assumed `closePane` populated undo-close history. Inspection showed only `closeTab` does so. Tested pane closure and tab undo separately, matching the existing app behavior.
