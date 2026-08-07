# Learnings: 450+ phantom test failures after starting the dev server (2026-08-06)

## `npx vitest run` after `npm run dev` fails every test that touches sqlite

**Symptom:** a suite that was fully green (2660 passed) suddenly reported ~456 failures, all of them in kanban / sessions / anything backed by the database, and all with the same error:

```
The module '.../node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 140. This version of Node.js requires
NODE_MODULE_VERSION 141.
```

Nothing in the working tree had changed between the green run and the red one.
The obvious first guess - "my change broke something" - is wrong, and so is the second one - "the module has always been like this" (the `.node` file's mtime is months old, because `electron-rebuild` writes the binary elsewhere and the timestamp on that path is not the thing that moved).

**Cause:** `better-sqlite3` is a native addon, so exactly one ABI can be built at a time, and this repo switches it back and forth in `package.json`:

- `predev` runs `rebuild:electron` (`electron-builder install-app-deps && electron-rebuild -f -w better-sqlite3`) - builds for Electron's ABI.
- `pretest` runs `rebuild:node` (`npm rebuild better-sqlite3`) - builds for the local Node's ABI.

Starting the dev server therefore leaves the module unloadable by plain Node.
`npm test` fixes it on the way in; `npx vitest run` does not, because invoking vitest directly skips the `pretest` hook.

**Fix:** run the suite with `npm test`, not `npx vitest run` - especially after a session that started `npm run dev` for `fleet-drive` verification.
`npm run test:watch` has the same guard (`pretest:watch`).

Switching Node versions does not help and is a red herring: no installed Node matches Electron's ABI, so the failure looks identical on every one of them.

**How to tell it apart from a real failure in two seconds:** every failing test carries `NODE_MODULE_VERSION` in its message, and the failures cluster in database-backed suites while everything pure stays green.
A real regression does not sort itself that way.

**Note:** running `npm test` rebuilds the addon for Node, which breaks sqlite in an already-running dev app.
Finish the `fleet-drive` verification, stop the dev server, then run the tests.
