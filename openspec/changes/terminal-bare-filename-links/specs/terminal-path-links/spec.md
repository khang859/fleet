## Purpose

Defines which text printed in a terminal pane Fleet treats as a file path the user can click, and what activating one does.
The contract matters because the pane shows output from tools Fleet does not control, so the rule for what is underlined has to be precise enough that nothing else in a line of output turns blue.

## ADDED Requirements

### Requirement: Bare filenames from the pane's working directory are clickable

A whitespace-delimited token that carries no path separator SHALL be treated as a file path when it exactly matches the name of an entry in the pane's current working directory.
This is what makes the output of `ls`, `ls -l` and similar commands clickable.

The match SHALL be exact, including case, on every platform.
A name printed in a different case from the one on disk is therefore not matched, even where the filesystem would resolve it: the cost of carrying a second, case-folded index of every directory is not worth a case that tools printing a directory's own names do not produce.

#### Scenario: A name printed by `ls` is clickable

- **WHEN** the pane's working directory contains `package.json` and a row of output contains the token `package.json`
- **THEN** hovering that token with Cmd (or Ctrl) held underlines it
- **AND** Cmd+click opens `package.json` from that working directory in a Fleet editor pane

#### Scenario: A name with no extension is clickable

- **WHEN** the pane's working directory contains an entry named `Makefile` and a row of output contains the token `Makefile`
- **THEN** the token is clickable and resolves to that entry

#### Scenario: A token that names nothing is left alone

- **WHEN** a row of output contains the tokens `Node.js`, `v1.2.3` and `either/or`, and the working directory contains no entry with any of those names
- **THEN** none of them is underlined, and clicking them does nothing beyond placing the cursor

#### Scenario: A word that happens to be a real entry is clickable

- **WHEN** the working directory contains a folder named `build` and a row of prose output contains the word `build`
- **THEN** the word is clickable and activating it reveals that folder
- **AND** this is accepted: the target named is the real one, and no decoration is shown unless the pointer is on it

### Requirement: Bare filenames follow the working directory

The set of clickable bare names SHALL be taken from the pane's live working directory, not the directory the pane was opened in.

#### Scenario: After a `cd` the new directory's names are the clickable ones

- **WHEN** a pane starts in a directory containing `a.txt`, then runs `cd sub` where `sub` contains `b.txt`
- **THEN** the token `b.txt` printed after the `cd` is clickable
- **AND** the token `a.txt` printed after the `cd` is not

### Requirement: Classify suffixes are ignored

A single trailing `*`, `@`, `=` or `|` SHALL be removed from a bare token before it is matched against the directory's entry names, and SHALL NOT be part of the clickable text.
These are the markers `ls -F` appends, and they are not part of the filename.

A trailing `/` already denotes a folder and SHALL continue to be handled as it is for separator paths.

#### Scenario: An executable listed by `ls -F`

- **WHEN** the working directory contains `build.sh` and a row contains the token `build.sh*`
- **THEN** `build.sh` is underlined and `*` is not
- **AND** activating it opens `build.sh`

### Requirement: A position suffix on a bare filename is honoured

A bare filename carrying a trailing `:<line>` or `:<line>:<col>` SHALL resolve to the named entry, and activating it SHALL open the file scrolled to that position.

#### Scenario: A grep-style hit on a file in the working directory

- **WHEN** the working directory contains `README.md` and a row contains `README.md:12:5`
- **THEN** `README.md` is clickable
- **AND** activating it opens `README.md` scrolled to line 12, column 5

### Requirement: Bare filenames obey the existing activation rules

A clickable bare filename SHALL behave exactly as a clickable separator path already does:

- Activation requires Cmd (macOS) or Ctrl; a plain click SHALL still place the cursor, and a drag SHALL still select text.
- A directory, or a file Fleet cannot display such as an archive, SHALL be revealed in the platform file manager rather than opened in a pane.
- The pane's right-click menu SHALL offer Open in Fleet, Reveal and Copy Path for the bare filename under the pointer, on the same terms as for a separator path.
- A pane whose foreground process is `ssh` or `mosh` SHALL produce no clickable paths at all, bare or otherwise, because the names printed belong to the remote machine.

#### Scenario: Plain click still selects

- **WHEN** the user clicks a clickable bare filename without Cmd or Ctrl held
- **THEN** nothing is opened and the click behaves as an ordinary terminal click

#### Scenario: A folder name reveals

- **WHEN** the user Cmd+clicks a bare token naming a directory in the working directory
- **THEN** that directory is revealed in the platform file manager and no editor pane opens

#### Scenario: A remote pane yields nothing

- **WHEN** a pane is running `ssh` and prints `ls` output whose names also exist in the local working directory
- **THEN** no token in that output is underlined or clickable

### Requirement: The directory listing is refreshed, not frozen

The set of names used for matching SHALL be refreshed within a few seconds of a change, so a file created after output was printed becomes clickable and a deleted one stops being clickable, without the user reloading or reopening the pane.

#### Scenario: A newly created file becomes clickable

- **WHEN** a row printed `out.log` while no such file existed, and a command then creates `out.log` in the working directory
- **THEN** hovering that same row a few seconds later shows `out.log` as clickable

#### Scenario: A deleted file stops being clickable

- **WHEN** a clickable bare filename is deleted from the working directory
- **THEN** hovering that row a few seconds later shows no link for it

### Requirement: Bare filename matching costs no per-token filesystem probe

Deciding whether a bare token names a file SHALL NOT issue a filesystem request per token.
Hovering a row of ordinary prose SHALL cost at most one directory read for the pane's working directory, shared across every row and reused while it is fresh.

A working directory holding more entries than the implementation's cap SHALL disable bare filename matching for that directory rather than read it repeatedly; separator paths SHALL continue to work there.

#### Scenario: A screen of output costs one directory read

- **WHEN** the user hovers across twenty rows of output in a pane whose working directory listing is already fresh
- **THEN** no further directory read and no per-token existence check is issued

#### Scenario: An enormous directory degrades quietly

- **WHEN** the pane's working directory holds more entries than the cap
- **THEN** bare tokens in that pane are not underlined
- **AND** tokens carrying a separator, such as `src/main/index.ts`, remain clickable
