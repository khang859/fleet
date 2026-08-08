import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  toCloneUrl,
  type FoundSkill,
  type SkillFetchResult
} from '../../../shared/agent-skill-install';
import { SkillFrontmatter } from '../../../shared/agent-skills';
import { splitFrontmatter } from '../markdown-frontmatter';
import { createLogger } from '../../logger';
import { loadFrom } from './definitions';
import { readCloned } from './scan';

const execFileAsync = promisify(execFile);
const log = createLogger('agent:skills:fetch');

/**
 * Cloning a repository to see what skills are in it.
 *
 * This is what "install a skill" means in practice today. There is a plugin
 * marketplace protocol, and almost nobody uses it to get a skill: they open
 * `anthropics/skills` or a community collection, and copy folders out of it.
 * Cloning and offering a checklist is that, with the copying done properly.
 *
 * The clone is shallow, into a temp folder, and thrown away as soon as the user
 * has taken what they want or closed the dialog. Nothing is kept and nothing is
 * tracked, which is the difference between this and a package manager - there is
 * no lockfile to go stale, no cache to invalidate, and re-fetching is just doing
 * it again.
 */

/** Longest a clone may take before it is abandoned. */
const CLONE_TIMEOUT_MS = 60_000;

/**
 * How deep to look for skills inside a repo.
 *
 * Counted from the temp folder the checkout sits *in* rather than from the
 * checkout, so one of these levels is spent reaching the repository itself.
 */
const MAX_DEPTH = 4;

/**
 * Checkouts made and not yet finished with.
 *
 * Kept so the install call that follows can be told which folders it is allowed
 * to copy from, and so they can be deleted. A clone the user never installs from
 * is removed when they close the dialog, and anything still here at quit is
 * removed then - a temp folder is not a leak, but a few hundred megabytes of
 * abandoned clones eventually is.
 */
const live = new Map<string, string>();

/** The folders a pending install may legitimately copy from. */
export function liveFetchRoots(): string[] {
  return [...live.values()].flatMap((dir) => rootsUnder.get(dir) ?? []);
}

/** Where in each checkout skills were actually found, for the root check. */
const rootsUnder = new Map<string, string[]>();

/** Clone `input`, and report the skills in it. */
export async function fetchSkills(input: string): Promise<SkillFetchResult> {
  const url = toCloneUrl(input);
  if (url === null) {
    throw new Error('That is not a repository. Use `owner/repo`, an https URL, or an ssh one.');
  }

  // The repository lands *inside* the temp folder rather than being it, because
  // a skill's folder has to be named after the skill and `fleet-skill-fetch-Xk2`
  // is not a name anything can be called. With a level above it, the checkout is
  // an ordinary child folder and a repository that is itself one skill needs no
  // special case downstream - it is a root holding a single skill, like any
  // other.
  const holder = await mkdtemp(join(tmpdir(), 'fleet-skill-fetch-'));
  const fetchId = randomUUID();
  const dir = join(holder, 'repo');

  try {
    await execFileAsync(
      'git',
      // `--` so a URL that survived validation still cannot be read as a flag,
      // and no `--recurse-submodules`: a skill repo does not need them, and a
      // submodule is another clone from another host on somebody else's say-so.
      ['clone', '--depth', '1', '--single-branch', '--no-tags', '--', url, dir],
      { timeout: CLONE_TIMEOUT_MS, windowsHide: true }
    );
  } catch (error) {
    await rm(holder, { recursive: true, force: true });
    throw new Error(cloneFailure(error));
  }

  const read = await readCheckout(holder, dir, input);
  if (read.found.length === 0) {
    await rm(holder, { recursive: true, force: true });
    throw new Error(`No skills in ${input}. Fleet looks for folders holding a SKILL.md.`);
  }

  live.set(fetchId, holder);
  rootsUnder.set(holder, read.roots);
  log.info(`cloned ${input}`, { dir: read.dir, skills: read.found.length });

  return { fetchId, from: input, dir: read.dir, found: read.found };
}

/**
 * What is in a checkout, once git has finished with it.
 *
 * Separated from the clone so it can be tested without one - the layouts a
 * repository can have are the interesting part, and `git clone` is not.
 * Exported for that reason only.
 */
export async function readCheckout(
  holder: string,
  checkout: string,
  from: string
): Promise<{ dir: string; roots: string[]; found: FoundSkill[] }> {
  const dir = await nameAfterItsSkill(checkout);
  const roots = await skillRoots(holder);
  const found: FoundSkill[] = [];
  for (const root of roots) {
    found.push(...(await readCloned(root, from)));
  }
  return { dir, roots, found };
}

/**
 * A checkout whose root is itself a skill, renamed to what that skill calls
 * itself.
 *
 * Some skills are published as a repository of their own rather than as a folder
 * in a collection, and for those the checkout directory *is* the skill folder.
 * The loader requires a skill's folder to be named after it, and the name the
 * clone happened to land under says nothing - so the folder is renamed to the
 * name in the frontmatter before anything reads it.
 *
 * `name` is checked against the format's own pattern by the schema, which is
 * lowercase words and single dashes, so it cannot climb anywhere. Anything else
 * - no `SKILL.md`, an unparseable one, a collection repository - is left where
 * it is, and is found by the walk in the ordinary way.
 */
async function nameAfterItsSkill(dir: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return dir;
  }

  const split = splitFrontmatter(text);
  if (split === null) return dir;

  let yaml: unknown;
  try {
    yaml = parseYaml(split.frontmatter);
  } catch {
    return dir;
  }

  const frontmatter = SkillFrontmatter.safeParse(yaml);
  if (!frontmatter.success) return dir;

  const named = join(dirname(dir), frontmatter.data.name);
  if (named === dir) return dir;
  try {
    await rename(dir, named);
  } catch {
    return dir;
  }
  return named;
}

/** Throw away a checkout, once it has been installed from or abandoned. */
export async function discardFetch(fetchId: string): Promise<void> {
  const dir = live.get(fetchId);
  if (dir === undefined) return;
  live.delete(fetchId);
  rootsUnder.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Everything still on disk at quit.
 *
 * Synchronous, which for filesystem work in this process is normally the wrong
 * choice and here is the only one that works. The shutdown path ends in
 * `process.exit(0)`, and an exit does not wait for a promise - an async delete
 * started here would be abandoned mid-unlink every single time, leaving exactly
 * the abandoned clones this exists to remove.
 */
export function discardAllFetches(): void {
  for (const [id, dir] of live) {
    live.delete(id);
    rootsUnder.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp folder that will not delete is the OS's problem now.
    }
  }
}

/**
 * The folders inside a checkout that hold skills.
 *
 * Repositories lay this out three ways and all three are common: skills at the
 * top level, skills under a `skills/` folder, and one skill *being* the repo.
 * Rather than encode which is which, this walks a few levels down and treats any
 * folder whose children include a `SKILL.md` as a root.
 *
 * The third way is why the walk starts at the folder the checkout sits in rather
 * than at the checkout: a repository that is one skill has its `SKILL.md` at the
 * top, so the root holding it is the level above.
 *
 * Bounded, because a checkout is somebody else's repository and walking all of
 * it to find two files is work nobody asked for.
 */
async function skillRoots(dir: string): Promise<string[]> {
  const roots: string[] = [];

  const walk = async (at: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await readdir(at);
    } catch {
      return;
    }

    const children: string[] = [];
    for (const name of entries.sort()) {
      if (name.startsWith('.')) continue;
      children.push(name);
    }

    // A folder is a root if any child folder holds a SKILL.md. Checked by
    // loading rather than by looking, so a folder full of unparseable files
    // does not register as somewhere to install from.
    if ((await loadFrom([['user', at]])).length > 0) roots.push(at);

    for (const name of children) {
      await walk(join(at, name), depth + 1);
    }
  };

  await walk(dir, 0);
  return roots;
}

/**
 * Why a clone failed, in a sentence.
 *
 * git writes the useful part to stderr and exits non-zero, and the thrown error
 * is mostly the command line. The first line of stderr is what the user needs -
 * "repository not found", "could not read Username" - and the rest is advice
 * about git configuration they did not ask for.
 */
function cloneFailure(error: unknown): string {
  const failure = CloneFailure.safeParse(error);
  const first = (failure.success ? failure.data.stderr : '')
    .split('\n')
    .map((line) => line.replace(/^(fatal|error):\s*/i, '').trim())
    .find((line) => line !== '');
  if (first !== undefined) return `Could not clone it: ${first}`;
  if (failure.success && failure.data.killed) return 'Could not clone it: it took too long.';
  return 'Could not clone it. Check the address and that you have access.';
}

/** What `execFile` rejects with, as much of it as this needs. */
const CloneFailure = z.object({
  stderr: z.string().catch(''),
  killed: z.boolean().catch(false)
});
