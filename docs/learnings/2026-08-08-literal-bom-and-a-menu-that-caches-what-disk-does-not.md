# A literal BOM in source, and a menu that cached what disk did not

Three things went wrong while building the `/pr-review` command, all of the same
shape: something that looked right and tested green while being wrong.

## A literal U+FEFF character in a regex

`splitFrontmatter` has to tolerate a byte-order mark before the opening `---`,
so it strips one first.
What got written was:

```ts
const withoutBom = contents.replace(/^\uFEFF/, '');   // what was meant
const withoutBom = contents.replace(/^﻿/, '');        // what was written
```

The second line contains an actual U+FEFF character between `^` and `/`.
It behaves identically - that is the problem.
It compiles, it passes, it strips BOMs, and it is invisible in every editor and
in every diff.
Nobody reading the file later can tell why the regex looks empty.

Found by dumping bytes rather than by reading:

```bash
od -c src/main/agent/markdown-frontmatter.ts | grep -n '357 273 277'
python3 -c "print(repr(open('src/main/agent/markdown-frontmatter.ts').read()))" | grep -o 'ufeff'
```

**The rule:** a non-ASCII character in source is written as an escape unless it
is text a human reads.
Control characters, zero-width characters, and BOMs are never written
literally.
When handling one, grep the file's bytes afterwards - the thing you are guarding
against is exactly the thing you cannot see if you accidentally type it.

## Two loaders that were one loader

`commands/definitions.ts` was written to deliberately mirror
`subagents/definitions.ts`, with a comment defending the duplication:

> Two loaders rather than one generic one because what they load is not the same
> thing: a subagent carries a model and a tool roster, and a command carries
> neither.

That is true about the *data* and irrelevant to the *loader*.
`loadFrom`, `readDir`, and `readOne` never touch a model or a tool roster - they
walk folders, split frontmatter, parse YAML, and log skips.
The two copies differed by a schema, one word in a log line, and one extra
name check: about eighty duplicated lines defended by an argument about
fields the duplicated code does not read.

Now `src/main/agent/markdown-definitions.ts` does the walk, and each kind brings
only its schema and a `build` callback.

**The rule:** when justifying duplication, the argument has to be about the code
being duplicated, not about the data flowing through it.
"These represent different things" does not justify two copies of a function
that is generic over the difference.

## A menu that cached what the loader deliberately did not

Main re-reads the command folders on every turn, on purpose, so that editing a
prompt file takes effect on the next message.
The renderer fetched the same list once per pane and kept it.

The result was a split that no test caught and that only shows up in a running
app: a command file written after a pane was opened could be *used* - typing
`/late-arrival` in full worked, because main reads disk - but was never
*offered*, because the menu's copy of the roster predated the file.
A comment documented the tradeoff, which made it look considered rather than
avoidable.

It was avoidable.
`useAgentCommands` now takes whether the user is currently naming a command and
refetches on that edge, keeping the list already on screen until the answer
arrives.
The menu still opens on the keystroke, and a file written a second ago is in it.

**The rule:** when one side of a boundary refuses to cache for a stated reason,
the other side does not get to cache silently.
Either the reason applies to both or it applies to neither.

## What actually caught these

Not the unit tests - all three were green throughout.
The BOM came from inspecting bytes, the duplication from a reviewer reading the
two files side by side, and the staleness from driving the real app:

```bash
npm run dev
npm run drive -- type 'textarea[placeholder^="Ask the agent"] >> nth=1' '/'
npm run drive -- eval '(() => [...document.querySelectorAll("[role=option]")].map(r => r.textContent))()'
```

The same session also proved the load-bearing claim of the feature by asking the
model, on turn three, to reproduce the first user message: it came back as the
expanded template rather than the typed `/expand-probe`, which is the behaviour
no unit test can demonstrate, because the thing being tested is that main is
stateless and re-expands history every turn.

Two notes on driving the app for this kind of check:

- Only the focused agent pane's composer is visible; `>> nth=0` will time out on
  a hidden one. Target the visible pane.
- `fleet-drive`'s `type` uses `fill()`, which does not move the pointer - but a
  pointer left sitting where a popover will appear fires `mouseenter` on whatever
  renders under it, which looks exactly like a wrong default selection. Move the
  pointer before judging a highlight.
