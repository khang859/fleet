# A closed builder tab left its Claude running

Make a workflow with an agent, then close the builder tab.
The tab went away, but its Claude process kept running, so its row stayed in the Claude Code sidebar.
"Edit with the agent" then did nothing visible, and a new builder added a second row next to the orphan.

## Cause

Main opens builder panes as retained panes, the same as workflow run panes.
Closing a tab with a `workflowRunId` never kills its panes: there is no undo entry, and the PTY GC skips retained panes.
For a run that is on purpose, because the run goes on and the Runs page shows it.
A builder has no other way back to the screen, so its agent became an invisible process.
`applyRunTab` also drops a tab update for a run whose tab a person closed, so reopening the builder could not show the hidden pane again.

## Fix

A builder tab carries `builderId`.
Closing that tab, or the agent's own terminal pane, calls `closeBuilder` on main, which kills the builder's pane.
The usual pane exit then drops the tab and frees the builder, so "Edit with the agent" resumes the talk in a new pane with `--resume`.
Closing only the draft panel leaves the agent running.

## A reload hid builder tabs too

Reload the renderer while a builder runs, and its tab went away while the agent kept running.
The workflows store asks main for its run tabs while App loads the saved layout.
When the layout came second, `loadWorkspace` replaced every tab, and run tabs are never saved.
`loadWorkspace` now keeps the run tabs that are already there.

## Rule

A pane that main retains needs an owner that ends it, and a tab that main owns must survive a layout load.
When a feature reuses retained panes, decide what closing its tab does, and test that the process is gone, not just the tab.
