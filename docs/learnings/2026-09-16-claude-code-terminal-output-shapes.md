# What paths actually look like in a terminal, once you go and look

Building clickable paths for terminal panes, I wrote a detector from a mental model of what agents and build tools print, and then ran it against a real `claude` session (v2.1.273) inside a live Fleet pane.
Two of my assumptions were wrong, and both would have shipped as "the feature just doesn't work on the output people actually look at".

The check itself was cheap: `npm run dev`, start `claude` in a pane, and dump the pane's xterm buffer over `npm run drive -- eval`, including each row's `isWrapped` flag.
That is worth doing *before* the detector is wired into anything, not after.

## `Tool(path)` is the main event

Claude Code's most common way of putting a path on screen is a tool-call label:

```
● Read(src/main/index.ts)
● Bash(npm run build)
```

My scanner stripped opening brackets from the left, which handles `(src/main/index.ts)`, but `Read(` is not a bracket - it is a word followed by one.
The whole token failed the shape test and nothing was detected on the single most common line in the app.

The fix is a prefix rule: a leading `[A-Za-z_][\w.-]*\(` is stripped along with the openers.
It is safe because the name before the paren cannot contain a path separator, so no genuine path is ever mistaken for a call prefix, and `src/a.ts(24,44)` is untouched because the paren is not leading.
`Bash(npm run build)` correctly yields nothing, because what is inside is not path-shaped.

## Two spellings of "line and column"

`a.ts:12:5` is what ripgrep, eslint and most unix tools print, and it was the only form I had handled.
`tsc` and MSBuild print `a.ts(24,44)` instead, and this repo's own typecheck output is full of it:

```
src/renderer/src/lib/claude-settings-lint.ts(24,44): error TS2353: ...
```

Right-trimming the `)` first left `...lint.ts(24,44`, whose last segment contains `(` and `,` and so failed the segment test.

The fix is two suffix patterns rather than one, plus an interleaved trim loop: try to peel a position suffix, else peel one closing character, and repeat.
One pass in a fixed order cannot handle it, because `)` is both a closer and part of the position syntax - `(a.ts(24,44))` only comes apart if the two steps alternate.

## Claude Code truncates; it does not wrap

I had expected long paths in the TUI to wrap across rows, and built wrapped-line stitching for it.
The stitching is needed - ordinary command output (a `tsc` run) does set `isWrapped: true` - but **every row of Claude Code's TUI reported `isWrapped: false`**.
It fits its own frame by truncating with an ellipsis instead:

```
src/renderer/src/hooks/use-termin…
src/renderer/src/…/use-terminal.ts
```

This turns out to be a safety property rather than a problem.
`…` (U+2026) is not in the set of characters allowed inside a path segment, so both of those shapes are rejected outright.
That is the behaviour you want: a truncated path is not a path, and half of one resolved against the cwd could name a real but *different* file.
Worth an explicit test, because it is the kind of thing a later "let's be more permissive about segment characters" change would quietly break.

## One false positive that is fine

`code.claude.com/docs/en/changelog`, printed in Claude Code's banner, matches.
It is genuinely indistinguishable from a relative path `docs/en/changelog` by shape alone, and no grammar will separate them.
It costs one `stat`, fails it, and is never decorated - which is exactly why existence-checking earns its keep: the detector gets to be generous, and the filesystem has the last word.
