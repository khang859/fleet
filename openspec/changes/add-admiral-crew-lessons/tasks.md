## 1. Crew lessons

- [x] 1.1 Add the `crew_lesson` card kind and its `CrewLesson` data to `src/shared/agency.ts` and the store's `data_json`; verify with an `agency-store` test that reads a lesson card back.
- [x] 1.2 Write the prompt, the request and the checks in `src/main/agency/lessons/`; verify with unit tests for each check and for the parser.
- [x] 1.3 Run the review from a `closed` callback on `CleanupRunner`, once per job, skipping jobs without crew, with an open lesson card, without a model, or over the cap, with one retry; verify with service tests using a fake completion.
- [x] 1.4 Apply an approved card through `writeFrontmatterFile`, re-reading the role, and record Not now in `declined_topics`; verify with tests for a bundled, a user and a project role, and for a role changed before the answer.
- [x] 1.5 Show the lesson on `QuestionCard` and in the reader; verify with a renderer test and in the running app with `npm run drive -- screenshot`.
- [x] 1.6 Document Crew lessons in `docs/admiral.md`.
