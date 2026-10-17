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

## A store selector that builds a new object each call

`JobPlanRow` selected `findPlanVersion(s.details, id)`, which returned a fresh `{ detail, version }` on every call.
zustand v5 selectors run through `useSyncExternalStore`, which wants the same value back while the store has not changed.
A fresh object each call can make React warn and render again and again.

Fix: `detailHolding(details, items, id)` in `src/renderer/src/store/agency-store.ts` returns the stored detail itself, and the row finds the item outside the selector.
Rule: a selector returns something already in the store, or a primitive, never a new object or array.
Use `useShallow` when a new object is the only way.
