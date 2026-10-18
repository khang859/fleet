# Workspace projects: picker, setup and tests

## A view test that imports a screen pulls in the live stores

A renderer test imported `MissingCard` from `ProjectSetup.tsx`.
The test failed at import with `Cannot read properties of undefined (reading 'onStreamChunk')`.
`ProjectSetup` imports Ask the Admiral, which imports the Admiral runtime and the agent store.
The agent store subscribes to `window.fleet.agent` when its module loads, and tests have no preload.

Fix: put a card a test renders in its own file with only view imports (`MissingCard.tsx`).
Keep store-backed screens out of `renderToStaticMarkup` tests.

## A submodule picked by itself is its own repository until the workspace is chosen

The first picker test expected a submodule folder to show as the umbrella's workspace row.
Before the client chooses the workspace, nothing says the submodule belongs to it, and it is a valid project alone.
So the picker shows it as a repository row, and the umbrella as a workspace row.
After `chooseWorkspace`, the registry maps the member to the project, and the picker shows one workspace row.
The test now checks both states.

## Hot reload resets the picker

A renderer edit while the picker was open reloaded the window, and the Admiral went back to its lobby.
The picking flag lives in renderer state only.
In an E2E run, finish renderer edits first, or open the picker again after each edit.
A `drive restart` also loses recent folders added with `addRecentFolder` through `eval`, so add them again.

## A missing submodule's place in member order is unknown

`orderMembers` reads each member's `package.json` to order dependencies first.
A submodule that is not checked out has no file to read, so it came first by default and looked wrong in the picker.
Members that are not checked out now follow the ordered ones, before the umbrella.

## The umbrella tests timed out only in the full suite

Each umbrella test builds four real repositories (about 0.8 s) and scans them a few times (about 0.4 s each).
Alone a test takes about 2.5 s, so it passed every time in a single-file run.
In `npm test`, many workers run git at once, and two tests went past the 5 s default.
The umbrella `describe` now has `{ timeout: 20_000 }`.
Time a real-git test alone with `--reporter=verbose`, and give it room if it is over half the default.
