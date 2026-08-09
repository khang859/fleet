import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'winston';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { splitFrontmatter } from './markdown-frontmatter';

/**
 * Definitions written as markdown with a frontmatter block, read off disk.
 *
 * Three kinds of thing are described this way - subagents, commands and skills.
 * What differs between them is the frontmatter they accept and the object they
 * become; everything up to that point is the same walk, and writing it three
 * times meant three copies of the rules about which files are skipped and which
 * folder being absent is normal.
 *
 * The walk has two shapes because the third kind has a different one on disk. A
 * subagent and a command are each one `.md` file; a skill is a *folder* holding
 * `SKILL.md` and whatever it bundles beside it, because that is what the
 * agentskills.io format says a skill is and Fleet does not get to redefine it.
 * `loadDefinitions` reads the flat kind and `loadFolderDefinitions` the nested
 * one, over the same per-file rules.
 *
 * Three places, most specific last: the ones that ship with the app, the user's
 * own, and the project's. A name found twice resolves to the most specific,
 * which is what makes overriding possible - a repo that wants its own `explore`
 * writes one and does not have to name it `explore-2` to be heard.
 *
 * Nothing here caches. The file is the interface: a prompt someone has just
 * edited should be the prompt the next turn runs, and a cache would make that a
 * question about when Fleet last looked rather than about what the file says.
 */

/** Where a definition was found. Decides precedence, and is shown in the UI. */
export type DefinitionSource = 'project' | 'user' | 'bundled';

export interface DefinitionLoader<F, D> {
  /** What one of these is called, for the log lines: `subagent`, `command`. */
  kind: string;
  /** What the frontmatter of this kind may say. */
  schema: ZodType<F>;
  /**
   * The definition a valid file describes, or `null` to drop it.
   *
   * `null` is for a rule only one kind has - a command may not be called
   * `clear`, a subagent has no such list. Whoever returns it logs why, because
   * only they know.
   */
  build: (file: {
    frontmatter: F;
    /** Everything below the frontmatter, trimmed and known to be non-empty. */
    body: string;
    source: DefinitionSource;
    path: string;
    /**
     * The folder the file was found in.
     *
     * Only skills have anything to do with it, and they have a lot: every path a
     * `SKILL.md` mentions is relative to here. Passed to all three rather than
     * added as a second kind of build function, because it is one field and it
     * is already known.
     */
    dir: string;
  }) => D | null;
  log: Logger;
}

/** Every definition in `sources`, later sources winning a repeated name. */
export async function loadDefinitions<F, D extends { name: string }>(
  sources: Array<[DefinitionSource, string]>,
  loader: DefinitionLoader<F, D>
): Promise<D[]> {
  const byName = new Map<string, D>();
  for (const [source, dir] of sources) {
    for (const definition of await readDir(dir, source, loader)) {
      byName.set(definition.name, definition);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The same, for the kind that is a folder rather than a file.
 *
 * A skill is `<name>/SKILL.md` plus whatever it bundles, so the walk is one
 * level deeper and the entry point has a fixed name. Everything below that -
 * precedence, one bad file costing only itself, a missing folder being normal -
 * is the flat walk's, unchanged.
 */
export async function loadFolderDefinitions<F, D extends { name: string }>(
  sources: Array<[DefinitionSource, string]>,
  entry: string,
  loader: DefinitionLoader<F, D>
): Promise<D[]> {
  const byName = new Map<string, D>();
  for (const [source, dir] of sources) {
    for (const definition of await readFolders(dir, entry, source, loader)) {
      byName.set(definition.name, definition);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readDir<F, D extends { name: string }>(
  dir: string,
  source: DefinitionSource,
  loader: DefinitionLoader<F, D>
): Promise<D[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // A folder nobody has made yet is the normal case for two of the three.
    return [];
  }

  const found: D[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const definition = await readOne(join(dir, name), source, loader);
    if (definition !== null) found.push(definition);
  }
  return found;
}

async function readFolders<F, D extends { name: string }>(
  dir: string,
  entry: string,
  source: DefinitionSource,
  loader: DefinitionLoader<F, D>
): Promise<D[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: D[] = [];
  for (const child of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // `isDirectory` is false for a symlink to one, and a symlinked skill is a
    // thing people do have - it is how you keep a skill in a repo and use it
    // everywhere. So a link is followed rather than skipped, and the `readOne`
    // below is what decides whether what it points at is a skill.
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const folder = join(dir, child.name);
    const definition = await readOne(join(folder, entry), source, loader, {
      // A folder with no `SKILL.md` is not a broken skill, it is not a skill.
      // Saying otherwise would put a warning in the log for every stray folder
      // someone happens to keep beside their skills.
      quietWhenMissing: true
    });
    if (definition !== null) found.push(definition);
  }
  return found;
}

/**
 * One file, or `null` with a line in the log saying why not.
 *
 * A bad file is skipped rather than allowed to fail the folder: one unparseable
 * prompt should cost you that prompt, not every other prompt beside it.
 */
async function readOne<F, D extends { name: string }>(
  path: string,
  source: DefinitionSource,
  loader: DefinitionLoader<F, D>,
  options: { quietWhenMissing?: boolean } = {}
): Promise<D | null> {
  const { kind, schema, build, log } = loader;

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (options.quietWhenMissing !== true) log.warn(`could not read ${path}`, error);
    return null;
  }

  const parsed = parseDefinitionFile(contents, schema, kind);
  if (!parsed.ok) {
    log.warn(`${path} ${parsed.why}; skipping`);
    return null;
  }

  return build({
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    source,
    path,
    dir: dirname(path)
  });
}

/** A file that parsed, or the reason it did not, phrased to follow its path. */
export type ParsedDefinitionFile<F> =
  | { ok: true; frontmatter: F; body: string }
  | { ok: false; why: string };

/**
 * The contents of one definition file, checked.
 *
 * Split out of `readOne` and exported because the *writer* has to run the same
 * checks. `markdown-definitions-write.ts` parses everything it serializes back
 * through this before it touches disk, so a file the reader would silently skip
 * is a write that fails loudly instead. That guarantee only holds while both
 * sides go through one function - two copies of these four steps would drift,
 * and the drift would be invisible until an entry quietly stopped loading.
 */
export function parseDefinitionFile<F>(
  contents: string,
  schema: ZodType<F>,
  kind: string
): ParsedDefinitionFile<F> {
  const split = splitFrontmatter(contents);
  if (split === null) return { ok: false, why: 'has no --- frontmatter block' };

  let yaml: unknown;
  try {
    yaml = parseYaml(split.frontmatter);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { ok: false, why: `has unreadable frontmatter (${detail})` };
  }

  const parsed = schema.safeParse(yaml);
  if (!parsed.success) {
    // Named rather than counted: the point of saying anything is so the person
    // who wrote the file can fix it, and "invalid" is not a fix.
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, why: `is not a valid ${kind} (${why.join('; ')})` };
  }

  const body = split.body.trim();
  if (body === '') return { ok: false, why: 'has no prompt below its frontmatter' };

  return { ok: true, frontmatter: parsed.data, body };
}
