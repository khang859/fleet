# Learnings: Remote SSH Browsing (2026-08-02)

## `sftp`'s `ls -l` is too lossy to parse for a file listing

**Problem:** The obvious way to list a remote directory is `sftp -b -` with `ls -l`, since the SFTP channel is already open for transfers.
Its output is unusable as a data source:

- No year on old entries and no seconds on any entry, so `Modified` columns and mtime sorting are wrong.
- Symlink targets are dropped, so there is no way to tell a directory symlink from a file symlink.
- Filenames containing newlines split into multiple rows, and there is no quoting to detect it.
- The format is locale-dependent.

**Fix:** Listing goes over a plain `ssh` exec channel running GNU `find` with an explicit, NUL-delimited format:

```
find <dir> -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%f\0'
```

`%T@` is a full-precision epoch, `%y` distinguishes `d`/`f`/`l`, and the `\0` terminator survives every filename byte except NUL, which POSIX already forbids.
`sftp` is still used for the actual byte transfers, where its output format does not matter.

**Takeaway:** Use a machine-readable format for anything parsed. Human-facing listing output is a UI, not an API.

---

## cmdk scores the item `value`, never the visible label

**Problem:** Typing `Browse Files on This` into the command palette returned "No results found." even though a command labelled exactly "Browse Files on This Remote Host" was sitting one keystroke away - `Browse` alone matched it fine.

**Cause:** `CommandPalette`'s `ItemRow` sets `value={`${item.section}:${item.id}`}` because cmdk uses `value` as the stable identity for highlight state.
cmdk's `defaultFilter` scores that `value` string plus `keywords` - the rendered children are never part of the searchable text.
So the palette was really searching over id slugs. That went unnoticed for a long time because most slugs spell out their label (`open-file` for "Open File..."); it only breaks when a slug is abbreviated (`browse-remote-here` for "Browse Files on This Remote Host").

**Fix:** Pass the label through as a keyword, so the row matches what the user can read on it:

```tsx
keywords={[item.label, ...(item.keywords ?? [])]}
```

**Takeaway:** When a widget takes both an identity and a search corpus, check which one it actually searches. If they are different props, the visible text has to be added to the corpus explicitly.

---

## fleet-drive `type` uses `fill()`, which replaces content

**Problem:** Driving an edit into a CodeMirror pane with `npm run drive -- type '.cm-content' 'new line'` produced a remote file containing only that line, which looked like the save path was truncating the document.

**Cause:** `scripts/drive/verbs.ts` implements `type` as Playwright `locator.fill()`, which clears the target before typing.
On a contenteditable that wipes the whole document. The save was correct; the harness had replaced the buffer.

**Takeaway:** `drive type` is "set the value of this field", not "type these keystrokes". Use `drive keys` to append to an editor, and confirm a suspected product bug against the harness's own semantics before chasing it.

Two related fleet-drive quirks found the same session:

- `drive eval` does not await promises - it returns `{}`. Stash the result on `window.__x` inside a `.then()` and read it in a second `eval` call.
- HMR can leave the renderer with stale closures after an edit to a component's props; a `location.reload()` before re-testing avoids a false negative.

---

## A tolerated `-rm` in an sftp batch still fails the whole batch

**Problem:** Uploading a file to a path that did not exist yet reported `remote delete /home/knguyen/fleet-remote-test/uploaded.bin: No such file or directory`, even though the bytes landed complete and correct.
Saving *over* an existing file worked, which is why the whole of Phase 1's save path passed without ever hitting this.

**Cause:** `sftpPutAtomic` staged the upload to a temp name and then ran one batch of two commands:

```
-rm "<target>"
rename "<temp>" "<target>"
```

The `-` prefix tells `sftp` to keep going past a failing command, and it does - but it still writes the failure to *stderr*.
`assertSftpOk` treats any stderr line matching `/^(Couldn't|Cannot|remote |Failure)/im` as fatal, so a deliberately tolerated failure was indistinguishable from a real one.
The transfer had already succeeded by then; only the report was wrong.

**Fix:** Do not pre-delete at all. OpenSSH servers advertise `posix-rename@openssh.com`, and the `sftp` client uses it automatically, so a bare `rename` atomically replaces the target whether or not it exists (verified live against the test host).
The `-rm` path survives only as a fallback for servers without the extension, and it runs as its own *discarded* batch - and only after `statRemotePath` confirms the staged copy is still there, so a failure can never leave the user holding neither file.

**Takeaway:** `-` prefixed sftp commands suppress the *exit*, not the *output*. Any error check that sniffs stderr has to run tolerated commands in a separate batch whose result is thrown away.
And when a code path has an "already exists" and a "does not exist" branch, test both - the happy path here was the *harder* one.

---

## `sftp` only prints its progress meter to a TTY

**Problem:** Headless `sftp -b -` gives no progress output at all, so there is nothing to parse for a progress bar.
Confirmed empirically: `printf 'progress\nget ...' | sftp -b -` against a real host emits nothing.

**Fix:** Progress is *observed* rather than reported.
Both directions stage through a temp path, and a timer stats that path: a local `.fleet-part` file for downloads (exact, 250 ms), the remote staging file for uploads (one poll behind, 1 s, over the already-multiplexed connection).
Samples are clamped so `transferred` never walks backwards - a staged file can briefly vanish between rename and stat, and a bar that snaps to 0 reads as a fault.

Staging buys cancellation safety for free: aborting kills the child mid-copy, and the only truncated file that can exist is the temp one, which the failure path removes.

---

## The same `posix-rename` that makes saves atomic makes renames dangerous

**Design note.** OpenSSH's sftp `rename` uses `posix-rename@openssh.com`, which replaces an existing target without a word.
That is exactly what an atomic save wants and exactly what a *user* rename does not: renaming `a.txt` to `b.txt` would destroy `b.txt` silently.

So the same primitive is used two ways, and the difference lives in the caller.
`sftpPutAtomic` relies on the overwrite; `renameEntry` in the store stats the destination first and refuses with `"b.txt" already exists in this folder.`
The check races a concurrent writer, which is the window every file manager has, and is worth far more than the race costs.

**Takeaway:** when one primitive serves two callers with opposite safety needs, the guard belongs at the call site that needs it, not inside the primitive - moving it down would break the other caller.

---

## sftp answers a duplicate `mkdir` with the word "Failure"

**Problem:** Creating a folder that already existed surfaced `remote mkdir "/home/knguyen/fleet-remote-test/reports 2026": Failure`, which tells the user nothing about what went wrong or what to do.

**Fix:** `createFolder` stats the path first and returns `"reports 2026" already exists in this folder.` for by far the most common failure.
Anything else still shows sftp's own text, which at least names the path - a generic message there would hide real problems like a read-only mount.

**Takeaway:** one extra round trip is a fair price for turning the most likely error into a sentence. Reserve the raw protocol error for the cases you did not anticipate.

---

## A memoised prop object reseeds a dialog's input

**Problem:** Text typed into the New Folder dialog vanished on its own during testing.

**Cause:** `RemoteNameDialog` seeds its input from `request` in `useEffect(..., [request])`, and the pane builds `request` with `useMemo(..., [dialog, pane?.cwd])` because the label reads "Created in \<cwd\>".
Any change to `cwd` produced a new object identity, the effect re-ran, and it reset `value` to the initial name - wiping what the user had typed.

**Fix:** seed on the transition into open, tracked with a ref, rather than on every identity change of `request`.

**Takeaway:** `useEffect` on an object prop fires on *identity*, not on meaning. When the effect is "initialise", gate it on the open/closed edge, not on the prop.

---

## Remote files reach the viewers through a local cache path

**Design note, not a bug.** Images, PDFs, Markdown and code all render through the existing local pipeline (`fleet-image://`, `fleet-pdf://`, `protocol-paths.ts`) with no SSH awareness at all.
A single component, `RemoteFileGate`, downloads the remote file into the cache and hands its child a *local* path, so every viewer stays unchanged.

Two consequences worth remembering:

- The cache filename is a content hash, so anything that shows a filename must use `remote?.path ?? filePath`, otherwise the status bar reads `1e63a328….png` instead of `gradient.png`.
- Features that write next to the file (Rune assist, image actions) are hidden on remote panes - they would write into the cache, where the output could never reach the server.
