import { dirname, join, posix as posixPath } from 'path';
import { existsSync, constants } from 'fs';
import { cp, mkdir, readFile, writeFile } from 'fs/promises';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { toWindowsAccessiblePath } from '../shared/path-platform';
import { isWslContext, type PathContext } from '../shared/shell-profiles';
import type { WorktreeSetup } from '../shared/ipc-api';

/**
 * Where a repository keeps its worktree setup, from its root. It is committed,
 * so everyone who makes a worktree of the repository gets the same setup.
 */
export const WORKTREE_SETUP_FILE = '.fleet/worktree.toml';

/** Git pathspecs for `.env` files at any depth, when a repository has no setup file. */
export const ENV_PATHSPECS = [':(glob)**/.env', ':(glob)**/.env.*'];

/** Lockfiles at a repository's root and what installs from them. The first one found wins. */
const INSTALL_COMMANDS = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['yarn.lock', 'yarn install'],
  ['package-lock.json', 'npm install'],
  ['uv.lock', 'uv sync'],
  ['poetry.lock', 'poetry install'],
  ['Gemfile.lock', 'bundle install'],
  ['composer.lock', 'composer install']
] as const;

/** A path inside the repository, `/`-separated, that cannot climb out of it or reach into `.git`. */
const RepoPath = z
  .string()
  .max(400)
  .transform((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''))
  .refine(
    (p) =>
      p !== '' &&
      !p.startsWith('/') &&
      !p.includes('\\') &&
      p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s !== '.git'),
    { message: 'must be a path inside the repository, like .env or apps/web/.env' }
  );

// Strict, so a misspelt key is an error rather than a setup that silently does nothing.
const WorktreeSetupSchema = z.strictObject({
  setup: z.string().max(20_000).default(''),
  copy: z.array(RepoPath).max(100).default([])
});

/** The setup a `.fleet/worktree.toml` describes. Throws with what is wrong in it. */
export function parseWorktreeSetup(text: string): WorktreeSetup {
  const parsed = WorktreeSetupSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));

  return {
    setup: parsed.data.setup.trim(),
    copy: [...new Set(parsed.data.copy)]
  };
}

/**
 * Whether `path` is git-ignored, given the ignored entries `git ls-files
 * --others --ignored --directory` printed. Git names a wholly ignored folder
 * once, with a trailing slash, rather than each file in it.
 */
export function isIgnored(path: string, ignored: string[]): boolean {
  return ignored.some((entry) =>
    entry.endsWith('/') ? `${path}/`.startsWith(entry) : entry === path
  );
}

/** A path as this process reaches it: a WSL posix path goes through the UNC share. */
export function localPath(ctx: PathContext | undefined, path: string): string {
  return isWslContext(ctx) ? toWindowsAccessiblePath(path, ctx) : path;
}

/** Join a path in the repository's own style: posix inside a WSL distro. */
export function pathJoin(ctx: PathContext | undefined, ...parts: string[]): string {
  return isWslContext(ctx) ? posixPath.join(...parts) : join(...parts);
}

/** The repository's setup file, or why it could not be read. No file is no setup, not an error. */
export async function readWorktreeSetup(
  repoPath: string,
  ctx?: PathContext
): Promise<{ setup: WorktreeSetup | null; setupError: string | null }> {
  const file = localPath(ctx, pathJoin(ctx, repoPath, WORKTREE_SETUP_FILE));
  try {
    return { setup: parseWorktreeSetup(await readFile(file, 'utf8')), setupError: null };
  } catch (err) {
    const missing = err instanceof Error && 'code' in err && err.code === 'ENOENT';
    if (missing) return { setup: null, setupError: null };
    const why = err instanceof Error ? err.message : String(err);
    return { setup: null, setupError: `${WORKTREE_SETUP_FILE}: ${why}` };
  }
}

/** The install command for the repository's lockfile; empty when it has none Fleet knows. */
export function detectInstallCommand(repoPath: string, ctx?: PathContext): string {
  const found = INSTALL_COMMANDS.find(([lockfile]) =>
    existsSync(localPath(ctx, pathJoin(ctx, repoPath, lockfile)))
  );
  return found?.[1] ?? '';
}

/** A setup as the text of a setup file. */
export function formatWorktreeSetup({ setup, copy }: WorktreeSetup): string {
  return [
    "# Typed into each new worktree's terminal once its prompt is up.",
    stringify({ setup }),
    '# Git-ignored files and folders, copied from the main checkout.',
    stringify({ copy })
  ].join('\n');
}

/** Write the repository's setup file. Throws rather than overwrite one, or write one that is broken. */
export async function writeWorktreeSetup(
  repoPath: string,
  setup: WorktreeSetup,
  ctx?: PathContext
): Promise<void> {
  const text = formatWorktreeSetup(setup);
  parseWorktreeSetup(text);

  const file = localPath(ctx, pathJoin(ctx, repoPath, WORKTREE_SETUP_FILE));
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, text, { flag: 'wx' });
  } catch (err) {
    const exists = err instanceof Error && 'code' in err && err.code === 'EEXIST';
    throw exists ? new Error(`${WORKTREE_SETUP_FILE} already exists.`) : err;
  }
}

/**
 * Copy one path from the main checkout into a worktree. Null when it was
 * copied, or why it was not: a path that is missing, that git does not
 * ignore, or that the worktree already has is never copied.
 */
export async function copyIgnoredPath(
  ctx: PathContext | undefined,
  repoPath: string,
  worktreePath: string,
  path: string,
  ignored: string[]
): Promise<string | null> {
  const from = localPath(ctx, pathJoin(ctx, repoPath, path));
  const to = localPath(ctx, pathJoin(ctx, worktreePath, path));

  if (!existsSync(from)) return 'not in the main checkout';
  if (!isIgnored(path, ignored)) return 'git does not ignore it';
  if (existsSync(to)) return 'the worktree already has it';

  try {
    // A copy-on-write clone where the disk can make one, so a big folder costs no space.
    await cp(from, to, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
