## Context

See proposal.md - Why.

The shipped pipeline is three pieces, and this change touches two of them:

1. `src/shared/terminal-path-detect.ts`: pure, no DOM and no `fs`.
   Splits a line on whitespace, unwraps punctuation and `Tool(...)` labels, peels a `:line:col` or `(line,col)` suffix, and requires the remainder to carry a separator or an unambiguous prefix.
2. `src/renderer/src/lib/terminal-path-links.ts`: an xterm `ILinkProvider`.
   Per hovered row it stitches wrapped rows into one logical line, runs the detector, resolves each candidate against the pane's live cwd, `stat`s them through an injected dep (cached 3s, in-flight deduped), re-reads the row to confirm nothing moved, and only then hands xterm the ranges to underline.
3. `src/renderer/src/hooks/use-terminal.ts`: wires the pane's cwd, path context, homes, remote flag and `window.fleet.file.stat` into the provider.

The separator rule in piece 1 is what excludes `ls` output, and the header of that file states the reason: without a separator, grammar alone cannot tell `index.ts` from `Node.js`, and each guess would cost a `stat`.

Two facts make this solvable now.
`ls` prints the names of entries in the pane's own cwd, and the pane already tracks that cwd live.
`window.fleet.file.readdir(dirPath, pathContext)` already exists, is single level, already bridges WSL paths, and already returns `{ name, path, isDirectory }`.

## Goals / Non-Goals

**Goals:**

- Keep the detector pure and keep the existence question out of it.
- Add no IPC channel, no preload surface, and no main process code.
- Make the per-token cost of a bare name zero filesystem calls, so the loose matching rule cannot become a probe storm.

**Non-Goals:**

- Watching the cwd for changes.
  A short TTL is enough for what the spec promises and costs nothing when idle.
- Tracking the argument of the command that produced a row, which is what `ls <other-dir>` would need.
- Any change to how a resolved path is opened, revealed or shown in the context menu.

## Decisions

### Membership in a directory listing, not a `stat` per token

A bare token is a file exactly when it is one of the names in the pane's cwd.
That is one directory read per cwd per TTL, and an in-memory `Set.has` per token.

Alternatives considered:

- **`stat` every bare token, letting the existing verifier decide.**
  Correct, and it would also handle `ls <other-dir>` if paired with a guess at the directory.
  Rejected on cost: a hovered row of prose is 10 to 30 tokens, each an IPC round trip to the main process, repeated per row the pointer crosses.
  The existing 3s cache does not help, because the misses are what dominate and they are the ones that repeat.
- **Heuristics that recognize `ls` output by its shape (column alignment, a preceding `total N` line, the command in the prompt above).**
  Rejected as fragile.
  Aliases, `-1`, `--color`, `exa`, `eza` and `lsd` all print something different, and the rule would silently stop matching whenever a user's setup differs from the one it was written against.

The listing is also strictly better than a `stat` for the two things the provider needs: it answers existence and `isDirectory` in the same read, so a bare candidate skips the `stat` path entirely.

### The detector takes the name set as an argument

`findCandidatePaths` gains one optional parameter:

```ts
findCandidatePaths(lineText: string, dirEntryNames?: ReadonlySet<string>): PathCandidate[]
```

Absent, the function behaves exactly as it does today: only tokens carrying a separator are candidates.

A token that fails the separator test is retried as a bare name: trailing `*`, `@`, `=` or `|` removed, then segment sanity, then set membership.
`.` and `..` are excluded.
Candidates gain `bare?: true` so the provider knows the existence question is already answered.

The module stays pure and stays the single place that decides what a path-shaped token is.
The alternative, a second exported function the provider calls separately, would duplicate the unwrap and suffix-peeling loop or force the provider to reconcile two overlapping candidate lists by offset.

### The provider owns the listing cache, shaped like the `stat` cache

A new injected dep mirrors `statPath`:

```ts
listDir(dir: string, ctx: PathContext): Promise<{ names: string[]; dirNames: string[] } | null>;
```

Keyed by resolved directory, TTL equal to `STAT_TTL_MS` (3s), in-flight deduped, same eviction shape.
`null` means "do not match bare names here", which is what an unreadable directory and an over-cap directory both return.

The cap is 5,000 entries.
Above it the pane is almost certainly sitting in something like `node_modules` or `/usr/bin`, where a full listing per TTL is real work and a bare-token match is mostly noise anyway.

`provideLinks` gains one `await` before detection: the listing, then the detector, then `stat` for separator candidates only, then the existing "re-read the row and require it to be identical" verification, which is unchanged and still the thing that makes the async gap safe.

The listing is requested on every hover, not only when the row looks like it needs one.
The cache makes that roughly one directory read per three seconds of active hovering, which is not worth a pre-scan pass to avoid.

### `isDirectory` for a bare name comes from the listing

The listing returns directory names alongside all names, so `actionForDetectedPath` gets the same `isDirectory` it gets today and folders keep revealing rather than opening.

### The match is exact on every platform

Case-folding for `win32` was considered and dropped.
It would need a second, case-folded view of every listing, and the returned name would then differ in case from the token on screen, which is the text being underlined and copied.
What it buys is a name printed in a case other than the one on disk, which the commands this feature exists for (a directory listing its own entries) never produce.

## Risks / Trade-offs

- **A prose word that is also a real entry gets underlined** (`build`, `docs`, `test` in agent chatter) → Accepted, and mitigated by the rules already in place: the match must be exact, and xterm only decorates a link while the pointer is on it.
  Activating it opens the real thing it names, so the worst case is a stray underline, not a wrong file.
- **`ls -l` columns collide with a filename** (a user or group name that matches an entry) → Same shape as above, rarer, and the same harmless outcome.
- **The listing is up to 3s stale** → The spec only promises refresh "within a few seconds", and the direction that matters (a file that appears after being printed) resolves itself on the next hover.
- **The pane's tracked cwd is wrong or missing** → Bare matching is simply off or matches the wrong directory's names, exactly as separator resolution already behaves; no new failure mode.
- **One extra await before links appear** → Links already arrive asynchronously, and the first hover in a directory is the only one that pays for the read.
- **`ls <other-dir>` still does nothing** → Documented as a non-goal.
  Nothing in this design blocks adding it later; it would need the directory the names belong to, not a different matching rule.
