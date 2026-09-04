# A close warning that promises a loss that does not happen

## What happened

The "warn before closing while work is running" dialog listed every kind of
live work main could see: panes mid-command, in-flight agent turns, live
subagents, and agent background commands. It told the user "Closing stops all
of them."

On macOS that was false for two of the four.

`shutdownAll()` - the function that calls `killAllBackgroundCommands()` and
`agentSubagents.cancelAll()` - is wired to `will-quit` and to the *non-darwin*
branch of `window-all-closed`:

```ts
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    shutdownAll();
    app.quit();
  }
  // On macOS: app stays running in the dock
});
```

So on macOS, clicking the window's X (rather than Cmd+Q) runs
`mainWindow.on('close')` - which kills the PTYs - and then nothing else. The
app sits in the dock, `shutdownAll()` never runs, and every subagent and
background command keeps running exactly as before. The dialog had just
announced their death.

## The fix

The warned population has to be the population *this particular close* ends,
which is knowable before the dialog is shown:

```ts
function closeEndsProcess(): boolean {
  return quitRequested || process.platform !== 'darwin';
}
```

`quitRequested` is set from `app.on('before-quit')`, which Electron raises
*before* the window's `close` event - verified, not assumed. Subagent and
background rows are then only counted and only listed when the close actually
ends the process.

## Why panes stayed in both cases

A terminal pane loses its PTY to the `ptyManager.killAll()` in the close
handler, which runs on every close.

An agent pane is subtler and worth remembering: the turn keeps running in main,
but the *transcript is written by the renderer* (`appendSession` in
`src/preload/index.ts` -> `AGENT_SESSION_APPEND`). A window that goes away
mid-turn takes the reply with it even though main carries on generating it. So
an in-flight turn is genuine loss on any close, and belongs in the warning.

Subagents are the opposite: `SubagentManager` writes their reports from main
via the session store, so they survive a window closing with nothing lost.

## The general lesson

When a dialog describes consequences, the set it describes and the set the code
destroys have to be derived from the same condition. Here the destroying code
(`shutdownAll`) was already platform- and quit-conditional, and the describing
code was not. Two independently-lifecycled subsystems teardown differently per
platform is exactly the place that drift hides.

## Related Electron facts, verified with a standalone probe

- `before-quit` fires **before** any window's `close` event, so a flag set
  there is readable in the close handler.
- `event.preventDefault()` in a window's `close` handler aborts the entire
  `app.quit()` sequence, not just that window's close.
- Therefore a confirmed close must finish the way it arrived: `app.quit()` if
  it began as a quit, `mainWindow.close()` if it began as a window close.
  Calling `close()` for a Cmd+Q would leave a macOS user in the dock.
- `quitConfirmed`-style flags must be reset in `createWindow()`, because macOS
  `activate` recreates the window in the same process and a stale flag would
  wave the next close straight through without asking.
