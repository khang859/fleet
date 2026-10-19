# E2E of the Bridge queue with a scripted Admiral

## Context

The Bridge queue needed an end-to-end check with real jobs, plans and questions: decide from the Bridge, Undo an approval, ask for a change and read v2.
A real model may not call the tool you want, and an approved plan must never hire real crew.

## What worked

- **A scripted Admiral.** A small OpenAI-compatible server (pattern in `2026-09-28-e2e-agent-tools-with-a-scripted-endpoint.md`) that calls only `job_open`, `job_plan` and `ask_client`.
  Crew are hired only by the Admiral's `crew_hire` tool, so a mock that never calls it makes approval safe.
  Triggers were `E2E:OPEN <name>`, `E2E:PLAN` and `E2E:ASK`, and the change-request wakeup text "Propose a new plan for this job with `job_plan`" answered with plan v2.
- **Point only the Admiral at it.** Add the `ep_mock` local endpoint and set `agency.admiral.model` to `local:ep_mock/mock`.
  Afterwards remove the endpoint and set the model back to `''`.
  First check no crew are live, since any Admiral wakeup in the meantime would get the mock's reply.
- **A throwaway git repository in the scratchpad.** Open its Bridge from `fleet-drive eval` with `(await import("/src/lib/open-admiral.ts")).openAdmiral("<repo>")`.
  "Looks right" on its setup screen saves that repository's setup only.
- **Click "Finish later" on "Meet your Admiral".** Its answers are rules for every project, so answering them changes the real client file.

## Gotchas

- **Another Admiral pane is mounted but hidden.** `document.querySelector('[data-item]')` found a hidden card in the real repository's Bridge, and `.focus()` silently did nothing.
  Filter for visible elements (`offsetParent !== null`) or use Playwright selectors with `visible=true` before pressing any key.
- **Clicking a step row moves focus out of the note.** Click the textarea again before Cmd+Enter.
- **Cancel the test jobs and reload the window afterwards.** Fake data seeded in renderer memory for earlier visual checks stays on the real Bridge until a reload.
- **Permissions cannot be tested this way.** They come only from Claude crew sessions through the hook, which means real crew.
  Cover deny-with-a-reason with main tests and renderer-only fake data instead.
