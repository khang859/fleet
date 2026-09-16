## 1. Detector: bare names against a supplied name set

- [x] 1.1 Add the optional `dirEntryNames` second parameter to `findCandidatePaths` in `src/shared/terminal-path-detect.ts` and a `bare?: true` field on `PathCandidate`; verify `npm run typecheck` passes and every existing case in `src/shared/__tests__/terminal-path-detect.test.ts` still passes with no second argument given.
- [x] 1.2 In the word loop, retry a token that fails the separator shape test as a bare name: strip one trailing `*`, `@`, `=` or `|`, reject `.` and `..`, require segment sanity, then require membership in `dirEntryNames`; verify with tests that `package.json`, `Makefile` and `build.sh*` match when listed, and that `Node.js`, `v1.2.3` and `either/or` do not when unlisted.
- [x] 1.3 Keep the existing `:line:col` and `(line,col)` peeling working for bare tokens; verify a test that `README.md:12:5` yields `text: 'README.md'`, `line: 12`, `col: 5` when `README.md` is in the set.
- [x] 1.4 Verify no bare candidate is produced when `dirEntryNames` is absent or empty, so a caller that cannot read the directory gets exactly today's behavior.

## 2. Provider: the cwd listing and its cache

- [x] 2.1 Add `listDir(dir, ctx): Promise<{ names: string[]; dirNames: string[] } | null>` to `PathLinkDeps` in `src/renderer/src/lib/terminal-path-links.ts`; verify `npm run typecheck` passes.
- [x] 2.2 Add a listing cache mirroring `statCached`: keyed by resolved directory, `STAT_TTL_MS` TTL, in-flight dedupe, cleared on `dispose`; verify a test that two hovers inside the TTL call `listDir` once and that a hover after the TTL calls it again.
- [x] 2.3 Fetch the listing (for the pane's live cwd, in the pane's path context) before running the detector in `provideLinks` and pass it the name set; verify a test that a bare name in the listing becomes a link.
- [x] 2.4 Skip `statPath` for candidates marked `bare` and take `isDirectory` from the listing's `dirNames`; verify a test that hovering a row of listed bare names issues zero `statPath` calls, and that a bare directory name yields `actionForDetectedPath` of `reveal`.
- [x] 2.5 Treat a `null` listing (unreadable or over cap) as "no bare matching" while separator paths keep working; verify a test covering both.
- [ ] 2.6 Verify the existing post-await row re-read guard still rejects stale rows with bare candidates present (extend the existing rewritten-row and reflow tests to a bare-name line).

## 3. Wiring

- [x] 3.1 Implement `listDir` in `src/renderer/src/hooks/use-terminal.ts` on top of `window.fleet.file.readdir`, returning `null` on failure or when `entries.length` exceeds the 5,000 cap; verify `npm run typecheck` and `npm run lint` pass.
- [x] 3.2 Verify no IPC channel, preload binding or main process file was touched by this change (`git diff --stat` shows only the three renderer/shared files and their tests).

## 4. End-to-end verification

- [x] 4.1 With `npm run dev` running, use `npm run drive` to run `ls` in a terminal pane, then screenshot with the pointer over a listed filename; verify the name is underlined and no surrounding column text is.
- [ ] 4.2 Verify Cmd+click on a listed file opens it in a Fleet editor pane, and Cmd+click on a listed folder reveals it in Finder.
- [ ] 4.3 Verify `ls -F` output: the name is underlined and its trailing `*` or `@` is not; and verify `ls -l` output links only the name column.
- [ ] 4.4 Verify `cd` into a subdirectory then `ls` links that directory's names, and that an `ssh` pane links nothing.
- [x] 4.5 Run `npm run typecheck`, `npm run lint` and the full test suite; then run `ripwire . --quality-delta` and address anything it reports as made worse.

## 5. Documentation

- [x] 5.1 Update the header comment of `src/shared/terminal-path-detect.ts`, whose stated rule ("a candidate must carry a separator") this change makes conditional; verify the new text names the listing as what replaces the separator for bare tokens.
- [x] 5.2 Add a learnings note under `docs/learnings/` only if something unexpected came up during implementation, per the project's learnings rule.
