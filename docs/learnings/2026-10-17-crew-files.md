# Crew role and playbook files

## A colon in a frontmatter description breaks the YAML

Two bundled roles had descriptions like `Designs the change: reads the code`.
YAML reads `key: value: more` as a nested mapping and fails, so the loader skipped both roles, and two playbooks that used them failed their role check too.
The test that loads every shipped crew file with no errors caught it.
Fix: use a dash instead of a colon in plain frontmatter values, or quote the value.
Keep the "shipped files load with no errors" test for every folder of bundled Markdown definitions.

## Saving setup silently re-imported a teammate's newer file

`ProjectsService.saveSetup` read every imported path from the repository again on each save.
So a teammate's newer commit, or the client's own edit of the project copy, was overwritten without asking.
This broke the rule that repo `.fleet/` files change nothing until the client imports them.
Fix (`src/main/agency/projects/imports.ts`): a path imported before keeps the project copy and its imported hash, unless the save lists it in `updates`.
The scan reports `newer` paths, and the setup screen shows a diff and an Update toggle.
