import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'winston';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { splitFrontmatter } from './markdown-frontmatter';

/**
 * Definitions written as markdown with a frontmatter block, read off disk.
 *
 * Two kinds of thing are described this way - subagents and commands - and a
 * third will be. What differs between them is the frontmatter they accept and
 * the object they become; everything up to that point is the same walk, and
 * writing it twice meant two copies of the rules about which files are skipped
 * and which folder being absent is normal.
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

/**
 * One file, or `null` with a line in the log saying why not.
 *
 * A bad file is skipped rather than allowed to fail the folder: one unparseable
 * prompt should cost you that prompt, not every other prompt beside it.
 */
async function readOne<F, D extends { name: string }>(
  path: string,
  source: DefinitionSource,
  loader: DefinitionLoader<F, D>
): Promise<D | null> {
  const { kind, schema, build, log } = loader;

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    log.warn(`could not read ${path}`, error);
    return null;
  }

  const split = splitFrontmatter(contents);
  if (split === null) {
    log.warn(`${path} has no --- frontmatter block; skipping`);
    return null;
  }

  let yaml: unknown;
  try {
    yaml = parseYaml(split.frontmatter);
  } catch (error) {
    log.warn(`${path} has unreadable frontmatter; skipping`, error);
    return null;
  }

  const parsed = schema.safeParse(yaml);
  if (!parsed.success) {
    // Named rather than counted: the point of saying anything is so the person
    // who wrote the file can fix it, and "invalid" is not a fix.
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    log.warn(`${path} is not a valid ${kind} (${why.join('; ')}); skipping`);
    return null;
  }

  const body = split.body.trim();
  if (body === '') {
    log.warn(`${path} has no prompt below its frontmatter; skipping`);
    return null;
  }

  return build({ frontmatter: parsed.data, body, source, path });
}
