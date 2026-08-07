import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { parse as parseYaml } from 'yaml';
import {
  SubagentFrontmatter,
  type SubagentDefinition,
  type SubagentSource
} from '../../../shared/agent-subagents';
import { createLogger } from '../../logger';

const log = createLogger('agent:subagents');

/**
 * Subagent definitions, read off disk.
 *
 * Files rather than settings, because a subagent is a prompt, and a prompt is
 * something you edit, diff, and review. The project ones live in the repo, so
 * "the reviewer this team uses" arrives with a clone instead of with a list of
 * setup instructions, and a change to it goes through the same review as a
 * change to anything else.
 *
 * Three places, most specific first: the project, the user, and the ones that
 * ship with the app. A name found twice resolves to the most specific, which is
 * what makes overriding possible - a repo that wants its own `explore` writes
 * one and does not have to name it `explore-2` to be heard.
 */

/** Where a folder of definitions sits, relative to a project or a home dir. */
const AGENTS_SUBDIR = join('.fleet', 'agents');

/**
 * The ones that ship with the app.
 *
 * Packaged builds get an `extraResources` copy rather than the asar, because a
 * path inside `app.asar` is not a path `readdir` can walk - see
 * `docs/learnings/2026-06-28-chat-skills-missing-from-packaged-app.md`, where
 * exactly this shipped broken once already.
 *
 * The dev branch is relative to the *bundle*, `out/main/index.mjs`, not to this
 * source file - the same two hops `index.ts` uses to find `resources/`. Counting
 * from the source layout instead gives a path that is right under vitest and
 * wrong in the app, which is the one way this can be wrong and still look tested.
 */
function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'agents')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'agents');
}

/**
 * Every definition available to a pane open on `cwd`.
 *
 * Read on every turn rather than cached, because the file is the interface: a
 * user editing a prompt wants the next dispatch to use it, and a cache would
 * make that a question about when Fleet last looked rather than about what the
 * file says. It is a handful of small files, and a turn is a network call.
 */
export async function loadSubagents(cwd: string): Promise<SubagentDefinition[]> {
  // Least specific first, so a more specific one of the same name overwrites.
  return loadFrom([
    ['bundled', bundledDir()],
    ['user', join(homedir(), AGENTS_SUBDIR)],
    ['project', join(cwd, AGENTS_SUBDIR)]
  ]);
}

/** The same, from folders stated outright. Exported for tests. */
export async function loadFrom(
  sources: Array<[SubagentSource, string]>
): Promise<SubagentDefinition[]> {
  const byName = new Map<string, SubagentDefinition>();
  for (const [source, dir] of sources) {
    for (const definition of await readDir(dir, source)) {
      byName.set(definition.name, definition);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readDir(dir: string, source: SubagentSource): Promise<SubagentDefinition[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // A folder nobody has made yet is the normal case for two of the three.
    return [];
  }

  const found: SubagentDefinition[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const path = join(dir, name);
    const definition = await readOne(path, source);
    if (definition !== null) found.push(definition);
  }
  return found;
}

async function readOne(path: string, source: SubagentSource): Promise<SubagentDefinition | null> {
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

  const parsed = SubagentFrontmatter.safeParse(yaml);
  if (!parsed.success) {
    // Named rather than counted: the point of saying anything is so the person
    // who wrote the file can fix it, and "invalid" is not a fix.
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    log.warn(`${path} is not a valid subagent (${why.join('; ')}); skipping`);
    return null;
  }

  const systemPrompt = split.body.trim();
  if (systemPrompt === '') {
    log.warn(`${path} has no prompt below its frontmatter; skipping`);
    return null;
  }

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    model: parsed.data.model,
    tools: parsed.data.tools ?? null,
    systemPrompt,
    source,
    path
  };
}

/**
 * The `---` block at the top, and everything after it.
 *
 * Hand-rolled rather than a library because the format is one rule - the file
 * opens with a fence, and the next fence on a line of its own closes it - and
 * every frontmatter library is a YAML parser with this wrapped around it, which
 * we already have. A leading BOM is stripped because an editor on Windows will
 * put one there and it makes the first fence stop being the first thing.
 */
function splitFrontmatter(contents: string): { frontmatter: string; body: string } | null {
  const text = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;

  // The closing fence has to be a whole line of its own. Searching for `\n---`
  // and taking the first hit would end the block early on a `----` rule or a
  // `---` inside a YAML block scalar, so a candidate that turns out to have
  // something after it on its line is skipped rather than fatal.
  for (let at = text.indexOf('\n---', 3); at !== -1; at = text.indexOf('\n---', at + 1)) {
    const after = text.slice(at + 4);
    if (after !== '' && !after.startsWith('\n')) continue;
    return { frontmatter: text.slice(4, at), body: after };
  }
  return null;
}
