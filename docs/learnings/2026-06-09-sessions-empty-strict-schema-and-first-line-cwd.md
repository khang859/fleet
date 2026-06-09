# Sessions tab showed "No sessions" — both sources silently dropped every session

## Symptom

Right after the Sessions tool shipped, the panel showed **"No sessions."** even though
the user had 141 Rune sessions (`~/.rune/sessions`) and 52 Claude transcripts
(`~/.claude/projects`). Both sources returned empty lists, so the default `rune` filter
(and `all`) showed nothing.

## Two independent root causes

Both failures were silent: each session is dropped inside a `try/catch` or a
`if (!x) continue`, so a bad assumption looks identical to "no data".

### 1. Rune — `content: null` failed the whole-session zod parse

Rune writes `message: { role: "", content: null }` on nodes without content (root/system
nodes). The schema declared:

```ts
content: z.array(contentBlockSchema).optional().default([])
```

`.optional()` and `.default()` only handle **`undefined`**, not **`null`**. `summarizeRune`
runs `safeParse` on the *entire* session, so one null-content node fails the parse → returns
`null` → the session is skipped. **All 141 files failed** (`["nodes",0,"message","content"]:
expected array, received null`).

Fix: coerce null/undefined → `[]`:

```ts
content: z.array(contentBlockSchema).nullish().transform((v) => v ?? [])
```

### 2. Claude — cwd read only from the first line, which is now metadata

`cwdFromTranscript` parsed only the **first non-empty line** for a top-level `cwd`. Recent
Claude Code versions prepend metadata lines that carry no cwd — observed first-line types:
`last-prompt` (33), `mode` (15), `file-history-snapshot` (4). None have `cwd`, so the
function returned `''` → `if (!cwd) continue` → **all 52 sessions dropped**. The cwd was
present on a later line in every file.

Fix: scan for the first line that actually carries a top-level `cwd`:

```ts
for (const line of content.split('\n')) {
  if (!line.includes('"cwd"')) continue;
  try {
    const parsed = cwdLineSchema.safeParse(JSON.parse(line));
    if (parsed.success && parsed.data.cwd) return parsed.data.cwd;
  } catch { /* skip malformed line */ }
}
```

## Why tests didn't catch it

The unit-test fixtures used idealized, hand-written data — clean array `content`, a `cwd` on
line 1. Real on-disk data had `content: null` and metadata-prefixed transcripts. Added
regression tests using the **real-world shapes** (`summarizeRune` with a null-content node;
`cwdFromTranscript` with leading `last-prompt`/`mode` lines).

## Lessons

- **Validate against real data, not fixtures.** A 30-second `node -e` script running the
  actual zod schema over `~/.rune/sessions` / `~/.claude/projects` found both bugs instantly;
  the green test suite hid them.
- **zod `.optional()`/`.default()` ≠ nullable.** External JSON that can be `null` needs
  `.nullish()` / `.nullable()`, usually with a `.transform(v => v ?? default)`.
- **Don't assume line 1 of a `.jsonl` transcript is a message.** Claude Code prepends
  metadata records; scan for the field you need.
- **Silent `continue`/`catch` on a whole record turns a parse bug into "no data".** When a
  list comes back empty, suspect over-strict parsing before suspecting empty sources.
- **Beware the sandbox resetting `cwd`.** An early `cd ~/.claude/projects && find .` ran
  against the wrong tree (shell cwd was reset), producing bogus counts. Use absolute paths in
  diagnostic scripts.
