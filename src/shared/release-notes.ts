/**
 * One released version's entry in `CHANGELOG.md`.
 *
 * `notes` is the body under the heading with the heading itself removed, which
 * is the same shape `electron-updater` delivers for a pending update - so the
 * Settings list can render a shipped version and a pending one through the same
 * component without knowing where either came from.
 */
export type ReleaseNote = { version: string; notes: string };

/**
 * A changelog heading: `## v2.117.0`, and nothing else.
 *
 * The leading `v` alone would be too loose - `## versioning` would parse as a
 * release of version "ersioning" - so the shape of a version number is part of
 * the match. That is a shape check, not semver parsing: a suffix like
 * `v2.118.0-beta.1` is carried through untouched, and nothing here compares or
 * orders two versions.
 */
const VERSION_HEADING = /^## v(\d+\.\d+\.\d+\S*)\s*$/;

/**
 * Split a changelog into one entry per released version.
 *
 * Used by both the app and `scripts/extract-release-notes.ts`, on purpose. The
 * script decides what a *pending* update's notes say, and this decides what the
 * same version says once it is installed and sitting in the Settings history.
 * If the two split differently, one version reads two ways depending on when
 * you look at it, which is the confusion this feature exists to remove.
 *
 * Order is the file's own. The changelog is written newest-first and the
 * release script prepends to it, so sorting here would only paper over a
 * malformed file rather than fix it. Anything before the first version heading
 * - the `# Changelog` title - belongs to no version and is dropped.
 */
export function parseChangelog(text: string): ReleaseNote[] {
  const entries: ReleaseNote[] = [];
  let current: { version: string; lines: string[] } | null = null;

  for (const line of text.split('\n')) {
    const heading = VERSION_HEADING.exec(line);
    if (heading) {
      if (current)
        entries.push({ version: current.version, notes: current.lines.join('\n').trim() });
      current = { version: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push({ version: current.version, notes: current.lines.join('\n').trim() });

  return entries;
}
