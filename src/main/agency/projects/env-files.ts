import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { EnvFileFound, ProjectSetup } from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { firstLink } from './files';

/**
 * The untracked env files of a project's members: `.env`, `.env.local` and
 * the like. Setup lists them with their variable names only. The client picks
 * which ones crew get, and each new worktree of the member gets its own copy,
 * never a link, so a crew edit never reaches the client's file. A copy is made
 * only where git ignores the path, so crew cannot commit it.
 */

/** An env file by its name. */
export const ENV_FILE = /^\.env(\..+)?$/i;

/** Past this, a file named like an env file is something else. */
const MAX_ENV_BYTES = 256 * 1024;

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;

/** A value as a shell or dotenv reads it: quotes taken off, an unquoted ` #` comment dropped. */
function unquote(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = raw.indexOf(quote, 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

/** Each variable an env file sets, in order, with its value. */
function assignments(text: string): Array<{ name: string; value: string }> {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = ASSIGNMENT.exec(line);
    return m === null ? [] : [{ name: m[1], value: unquote(m[2].trim()) }];
  });
}

/** The variables an env file sets, each once. */
export const envNames = (text: string): string[] => [
  ...new Set(assignments(text).map((a) => a.name))
];

/** The values an env file sets, for the redaction; empty ones are left out. */
export const envValues = (text: string): string[] =>
  assignments(text)
    .map((a) => a.value)
    .filter((v) => v !== '');

/** Shorter values would hide too much text behind the mask. */
const SECRET_MIN_CHARS = 6;

/** Every value in `secrets` masked, so an env file's values never reach the Admiral or an export. */
export function redactEnvValues(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((s) => s.length >= SECRET_MIN_CHARS)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.split(secret).join('[env value]'), text);
}

/** A regular file's bytes, or null when it is missing, a link, or too big for an env file. */
async function readEnvFile(path: string): Promise<Buffer | null> {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size > MAX_ENV_BYTES) return null;
  return readFile(path).catch(() => null);
}

/**
 * The untracked env files in a repository's working tree, with the variable
 * names each sets. Untracked folders count as one entry, so a big ignored
 * folder like `node_modules` is never walked.
 */
export async function findEnvFiles(
  root: string,
  member: string,
  git: GitRun
): Promise<EnvFileFound[]> {
  const untracked = async (extra: string[]): Promise<string[]> =>
    (
      (await git(
        ['ls-files', '-z', '--others', '--exclude-standard', '--directory', ...extra],
        root
      )) ?? ''
    )
      .split('\0')
      .filter((p) => p !== '' && !p.endsWith('/') && ENV_FILE.test(basename(p)));
  const [ignored, loose] = await Promise.all([untracked(['--ignored']), untracked([])]);
  const found: EnvFileFound[] = [];
  for (const [paths, isIgnored] of [
    [ignored, true],
    [loose, false]
  ] as const) {
    for (const path of paths) {
      const bytes = await readEnvFile(join(root, path));
      if (bytes !== null) {
        found.push({ member, path, vars: envNames(bytes.toString('utf8')), ignored: isIgnored });
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** A member's main checkout. */
type MemberRoot = { name: string; root: string };

/** Every value of the env files the client gave crew, read from the main checkouts. */
export async function envSecrets(
  setup: ProjectSetup | null,
  members: MemberRoot[]
): Promise<string[]> {
  const values = new Set<string>();
  for (const m of setup?.members ?? []) {
    const root = members.find((r) => r.name === m.name)?.root;
    if (root === undefined) continue;
    for (const file of m.envFiles) {
      const bytes = await readEnvFile(join(root, file));
      for (const v of bytes === null ? [] : envValues(bytes.toString('utf8'))) values.add(v);
    }
  }
  return [...values];
}

/** A worktree of a member in a new job workspace, and the main checkout it was added from. */
type MemberWorktree = { member: string | null; path: string; from: string | null };

/**
 * Copy the env files the client gave crew into a new workspace's worktrees,
 * mode 600, before setup runs in them. Refused, naming the file, when the
 * path in the worktree goes through a symlink, when git does not ignore it
 * there, or when the client's file is gone.
 */
export async function copyEnvFiles(
  setup: ProjectSetup | null,
  parts: MemberWorktree[],
  git: GitRun
): Promise<void> {
  for (const m of setup?.members ?? []) {
    const part = parts.find((p) => p.member === m.name && p.from !== null);
    if (part?.from == null) continue;
    for (const file of m.envFiles) {
      const label = m.path === '.' ? file : `${m.path}/${file}`;
      await copyEnvFile({ label, file, member: m.name, worktree: part.path, from: part.from }, git);
    }
  }
}

async function copyEnvFile(
  c: { label: string; file: string; member: string; worktree: string; from: string },
  git: GitRun
): Promise<void> {
  const dest = join(c.worktree, c.file);
  const link = await firstLink(c.worktree, dest);
  if (link !== null) throw new Error(`Not copying ${c.label} through ${link}: it is a symlink.`);
  if ((await git(['check-ignore', '--quiet', '--', c.file], c.worktree)) === null) {
    throw new Error(
      `${c.label} is not ignored by git, so crew could commit it. Add it to .gitignore, or stop giving it to crew.`
    );
  }
  const bytes = await readEnvFile(join(c.from, c.file));
  if (bytes === null) throw new Error(`${c.label} is not in ${c.member}'s checkout any more.`);
  await mkdir(dirname(dest), { recursive: true });
  // `wx` never writes through a link or over a file the worktree already has.
  await writeFile(dest, bytes, { mode: 0o600, flag: 'wx' });
}
