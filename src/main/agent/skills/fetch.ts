import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  toCloneUrl,
  type FoundSkill,
  type SkillFetchResult
} from '../../../shared/agent-skill-install';
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

/** How deep to look for skills inside a repo. */
const MAX_DEPTH = 3;

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

  const dir = await mkdtemp(join(tmpdir(), 'fleet-skill-fetch-'));
  const fetchId = randomUUID();

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
    await rm(dir, { recursive: true, force: true });
    throw new Error(cloneFailure(error));
  }

  const roots = await skillRoots(dir);
  const found: FoundSkill[] = [];
  for (const root of roots) {
    found.push(...(await readCloned(root, input)));
  }

  if (found.length === 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`No skills in ${input}. Fleet looks for folders holding a SKILL.md.`);
  }

  live.set(fetchId, dir);
  rootsUnder.set(dir, roots);
  log.info(`cloned ${input}`, { dir, skills: found.length });

  return { fetchId, from: input, dir, found };
}

/** Throw away a checkout, once it has been installed from or abandoned. */
export async function discardFetch(fetchId: string): Promise<void> {
  const dir = live.get(fetchId);
  if (dir === undefined) return;
  live.delete(fetchId);
  rootsUnder.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Everything still on disk at quit. */
export async function discardAllFetches(): Promise<void> {
  await Promise.all([...live.keys()].map(async (id) => discardFetch(id)));
}

/**
 * The folders inside a checkout that hold skills.
 *
 * Repositories lay this out three ways and all three are common: skills at the
 * top level, skills under a `skills/` folder, and one skill *being* the repo.
 * Rather than encode which is which, this walks a few levels down and treats any
 * folder whose children include a `SKILL.md` as a root.
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
