# Two ways the dev app lies to you

Both of these cost most of an afternoon while building the OpenRouter server-tool work, and both look like a bug in the code you just wrote.

## A stale `out/` bundle, with only half your change in it

The symptom was a renderer crash - `Cannot read properties of undefined (reading 'enabled')` - on a settings field that had a default.
`settings.ai.agent.advisor` came back `undefined` in the running app while a vitest probe against the same source returned the default correctly.

The cause was the built `out/main/index.mjs`.
It had the fresh `settings-store.ts`, which merges `DEFAULT_SETTINGS.ai.agent.advisor` over the saved file, and a stale `agent-types.ts`, which had no `DEFAULT_AGENT_ADVISOR` in it at all.
So the merge ran and merged nothing.

The fix:

```bash
rm -rf out node_modules/.vite*
npm run dev
```

The lesson is the diagnosis rather than the command.
When the app disagrees with a unit test about the value of a constant, stop debugging the code.
One of them is not reading the file you edited, and it is never the test.

A related trap in the same family: `npm run build` rebuilds native modules for Electron's ABI, which leaves `better-sqlite3` unloadable by plain node afterwards.
Thirty-eight unrelated tests then fail with `NODE_MODULE_VERSION 140 ... requires 141`.
`npm rebuild better-sqlite3` puts it back.

## `fleet-drive` connects and then hangs

The symptom was `browserType.connectOverCDP: Timeout 30000ms exceeded` **after** a line reading `<ws connected>`.
Connecting works; finding the window does not.

The cause is more than one dev Electron alive at once.
The debug port is fixed, so the first instance to start owns it, and every later one writes a `.fleet-drive/session.json` pointing at a port that belongs to a process it is not.
`drive` then attaches to the old instance and looks for a window on the new instance's renderer URL, which that browser has never heard of.

Sometimes the error says so outright - "Connected to CDP on port 57856 but found no Fleet window at http://localhost:5175" - and that sentence is the whole diagnosis.

Check who actually owns the port rather than trusting `pkill`:

```bash
lsof -ti :57856          # the pid that really holds it
kill -9 <pid>
```

`pkill -f "electron.*fleet"` does not match the dev binary, whose argv is
`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
It exits cleanly, reports success, and leaves the process running.

A renderer URL of `:5175` rather than `:5174` in `session.json` is the early warning: Vite moved up a port because something was already on the first one, which means a previous dev instance never died.
