## Purpose

Fleet carries the release notes for every version it has shipped up to the build the user is running, and presents that history in Settings > Updates so that someone who has just updated - or who skipped several versions - can read what changed without leaving the app.

## ADDED Requirements

### Requirement: The app carries its own release-note history

The packaged application SHALL include the project changelog, and SHALL be able to produce the release notes for every version it documents without network access.

#### Scenario: History is available offline

- **WHEN** the user opens Settings > Updates on a packaged build with no network connection
- **THEN** the release-note history for every version the build documents is shown

#### Scenario: History is available in development

- **WHEN** the app runs unpackaged from the repository
- **THEN** the same history is read from the repository changelog, so what a developer sees matches what a packaged build shows

#### Scenario: The changelog cannot be read

- **WHEN** the changelog file is missing or unreadable
- **THEN** the release-note history is reported as empty, no error is surfaced to the user, and the rest of the Updates page - version, check button, update status - continues to work

### Requirement: Release notes are split by version

The system SHALL divide the changelog into one entry per released version, each carrying that version's identifier and the note body that follows it, and SHALL order the entries newest first.

#### Scenario: Each version heading starts an entry

- **WHEN** the changelog contains version headings in the form `## vX.Y.Z` followed by note bodies
- **THEN** one entry is produced per heading, its version is the heading's version without the leading `v`, and its body is every line up to the next version heading

#### Scenario: Order follows the changelog

- **WHEN** entries are produced
- **THEN** they are returned in the order the changelog lists them, which is newest first

#### Scenario: Content outside a version heading is ignored

- **WHEN** the changelog contains a document title or other prose before the first version heading
- **THEN** that content is not attributed to any version and does not appear in any entry

#### Scenario: An entry with no body

- **WHEN** a version heading is immediately followed by another version heading or by the end of the file
- **THEN** an entry is still produced for that version, with an empty body

### Requirement: Settings shows every version's notes

Settings > Updates SHALL present the release-note history as a list of versions, newest first, where each version can be expanded to read its notes and collapsed again.

#### Scenario: The list is shown

- **WHEN** the user opens Settings > Updates
- **THEN** a release-notes section lists every version in the history, newest first, each row showing its version number

#### Scenario: The installed version is open by default

- **WHEN** the release-notes list is first shown and the installed version appears in the history
- **THEN** that version's entry is expanded and labelled as the current version, and every other entry is collapsed

#### Scenario: Expanding another version

- **WHEN** the user activates a collapsed version's row
- **THEN** that version's notes are shown, and activating the row again hides them

#### Scenario: Notes render as formatted text

- **WHEN** a version's notes are shown
- **THEN** their markdown - bullets, bold lead-ins, inline code, links - is rendered rather than displayed as literal punctuation

#### Scenario: The installed version is not in the history

- **WHEN** the running version has no entry in the history
- **THEN** the list is still shown with every entry collapsed, and no entry is marked current

#### Scenario: No history available

- **WHEN** the history is empty
- **THEN** no release-notes list is shown, and the rest of the Updates page is unaffected

### Requirement: A pending update's notes stay distinct from the history

When an update is staged or downloading, its notes SHALL be presented separately from and above the shipped history, identified by the version it will install.

#### Scenario: A staged update

- **WHEN** an update has been downloaded and is ready to install
- **THEN** its notes are shown expanded above the history, identified by the version being installed and marked as pending rather than current

#### Scenario: An update still downloading

- **WHEN** an update is downloading and carries notes
- **THEN** those notes are shown in the same pending position, above the history

#### Scenario: The pending version is not duplicated

- **WHEN** a pending update's version also appears in the shipped history
- **THEN** it is presented once, in the pending position, and not repeated as a history entry

#### Scenario: No pending update

- **WHEN** no update is staged or downloading
- **THEN** no pending entry is shown and the history is presented on its own
