# Upgrading to Electron 45: what actually bit

Security upgrade from Electron 39 to 45, with `simple-git` 4, `better-sqlite3` 13 and `npm audit fix`.

## A new Electron binary blocks startup on the macOS Keychain

`npm run drive -- up` timed out after 180s with no error in the log.
The last log line was a `safeStorage` deprecation warning, the process used 0% CPU, and it ignored SIGTERM.

`sample <pid>` showed the main thread parked in `SecItemCopyMatching`.
macOS treats a new Electron binary as a new app, so it shows a Keychain prompt, and `safeStorage` waits for it synchronously on the main thread.
There is no crash and no timeout. The app waits for a person.

- A person: click Always Allow once per new Electron binary.
- An agent: launch with `npm run dev -- -- --use-mock-keychain`. It never touches the real Keychain.
- `drive stop` cannot see this app because the session file is written later. Stop the pid, using `kill -9`, because SIGTERM is never serviced.

## The `clipboard` module is async from Electron 44

`readText` and `writeText` return promises in the main process.
TypeScript caught the reads, but it did not catch `writeClipboard: (text) => clipboard.writeText(text)`, because a promise is assignable to a `void` return.
`no-misused-promises` is what flagged it.

## `npm run format -- <file>` formats the whole repo

The script is `prettier --write .`, so the path is added to `.`, not used in its place.
To format one file, use `npx prettier --write <file>`.

## `eslint --fix` can be wrong after a typescript-eslint bump

`npm audit fix` moved typescript-eslint from 8.57 to 8.72.
Two removed assertions broke `tsc`: `{}` in a `useMemo` branch, and a literal inside an `it.each` table.
Always run typecheck after `--fix`.

`no-meaningless-void-operator` now rejects `void unused;`, which this code used to drop keys from `...rest`.
The rule config now sets `ignoreRestSiblings: true` instead.

## Checking a packaged build

`FLEET_DEV=1 dist/mac-arm64/Fleet.app/Contents/MacOS/Fleet --use-mock-keychain` runs in a dev sandbox.
`__FLEET__` does not exist in a production bundle, so `term-send` and `term-wait` fail. Use `keys`, `eval` and `screenshot`.
The `app-update.yml` ENOENT in the log is expected from a `--dir` build.

## Still to do

Electron 46 removes the synchronous `safeStorage` methods.
Move every caller to the async methods before that upgrade.
