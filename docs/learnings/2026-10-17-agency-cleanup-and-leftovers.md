# Agency cleanup: where Leftovers live, and a waiting job at restart

## Leftovers on a closed job never showed

The first draft put a job's leftovers (kept or failed cleanup steps) on `AgencyJobDetail`.
The sheet never showed them.
A job leaves the agency snapshot once it is `closed` or `cancelled`, so no sheet can open its detail.
Cleanup ends the job, so every leftover belongs to a job the UI can no longer reach.

Fix: leftovers are repository-level state on `AgencySnapshot.leftovers`.
`ResourceStore.leftovers(repoId)` joins `job_resources` to `jobs` on `repo_id`.
Rule: state that must outlive a job belongs on the snapshot, not on the job's detail.

## A waiting job could not be interrupted at restart

Startup reconcile applies `interrupt` to jobs whose crew panes are gone.
The machine only had `running -> interrupted`.
A job that waits on the client (`waiting`) can still have crew at work, because `syncWaiting` blocks it again after `unblocked`.
So the reconcile threw on those jobs.

Fix: a `waiting -> interrupted` edge in `job-machine.ts`, plus the spec and design table rows.

## renderToStaticMarkup has no comment markers

`react-dom/server` `renderToString` puts `<!-- -->` between adjacent text nodes.
`renderToStaticMarkup` does not.
The sheet tests use `renderToStaticMarkup`, so expected strings like `Kept: 3 untracked files` have no markers.
