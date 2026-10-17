import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { AgencyRepoRef, RepoResolution } from '../../../shared/agency';
import { parseJsonAs } from '../../../shared/parse-json';
import { repoIdFor } from '../repo-identity';
import { readTextOrNull } from './files';

/** A submodule entry of `.gitmodules`. */
export type GitmoduleEntry = { name: string; path: string; url: string | null };

/** One member as detection finds it, before anything is asked of its repository. */
export type DetectedMember = {
  name: string;
  /** Relative to the project root; `.` for the umbrella. */
  path: string;
  /** Absolute path of the member's folder. */
  dir: string;
  /** Null for a submodule that is not checked out. */
  repo: (AgencyRepoRef & { gitCommonDir: string }) | null;
  umbrella: boolean;
  /** The URL `.gitmodules` gives, for a submodule. */
  url: string | null;
};

export type DetectedWorkspace = {
  kind: 'submodules' | 'folder';
  project: AgencyRepoRef;
  /** In member order: dependencies first, the umbrella last. */
  members: DetectedMember[];
};

export type DetectDeps = {
  /** Git identity of a folder, not the project it may belong to. */
  identify: (path: string) => Promise<RepoResolution>;
};

/**
 * The submodules `.gitmodules` lists, in file order. Only `path` and `url` are
 * read; an entry without a path is not a submodule git would check out.
 */
export function parseGitmodules(text: string): GitmoduleEntry[] {
  const out: GitmoduleEntry[] = [];
  let current: { name: string; path: string | null; url: string | null } | null = null;
  const flush = (): void => {
    if (current?.path) out.push({ name: current.name, path: current.path, url: current.url });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[submodule\s+"(.+)"\]$/.exec(line);
    if (section) {
      flush();
      current = { name: section[1], path: null, url: null };
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      current = null;
      continue;
    }
    const kv = /^(path|url)\s*=\s*(.+)$/.exec(line);
    if (kv && current) current[kv[1] === 'path' ? 'path' : 'url'] = kv[2].trim();
  }
  flush();
  return out;
}

const okRef = (res: RepoResolution): (AgencyRepoRef & { gitCommonDir: string }) | null =>
  res.ok && res.gitCommonDir !== null
    ? { repoId: res.repoId, root: res.root, name: res.name, gitCommonDir: res.gitCommonDir }
    : null;

/** Member names are the folder names, or the whole path when two folders share a name. */
function memberNames(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(basename(p), (counts.get(basename(p)) ?? 0) + 1);
  return paths.map((p) => ((counts.get(basename(p)) ?? 0) > 1 ? p : basename(p)));
}

async function submodules(
  umbrella: AgencyRepoRef & { gitCommonDir: string },
  deps: DetectDeps
): Promise<DetectedMember[] | null> {
  const text = await readTextOrNull(join(umbrella.root, '.gitmodules'));
  const entries = text === null ? [] : parseGitmodules(text);
  if (entries.length === 0) return null;
  const names = memberNames(entries.map((e) => e.path));
  const members = await Promise.all(
    entries.map(async (entry, i): Promise<DetectedMember> => {
      const dir = join(umbrella.root, entry.path);
      // An empty submodule folder resolves to the umbrella, as git climbs up from it.
      const repo = okRef(await deps.identify(dir));
      const checkedOut = repo !== null && repo.repoId !== umbrella.repoId && repo.root === dir;
      return {
        name: names[i],
        path: entry.path,
        dir,
        repo: checkedOut ? repo : null,
        umbrella: false,
        url: entry.url
      };
    })
  );
  return [
    ...members,
    {
      name: umbrella.name,
      path: '.',
      dir: umbrella.root,
      repo: umbrella,
      umbrella: true,
      url: null
    }
  ];
}

/** Child folders that are each a repository's own root; hidden folders are skipped. */
async function childRepos(root: string, deps: DetectDeps): Promise<DetectedMember[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const found = await Promise.all(
    dirs.map(async (name) => {
      const dir = join(root, name);
      const repo = okRef(await deps.identify(dir));
      return repo !== null && repo.root === dir ? { name, dir, repo } : null;
    })
  );
  return found
    .filter((m) => m !== null)
    .map((m) => ({
      name: m.name,
      path: m.name,
      dir: m.dir,
      repo: m.repo,
      umbrella: false,
      url: null
    }));
}

const PackageJson = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional()
});

async function packageOf(dir: string): Promise<{ name: string | null; deps: Set<string> }> {
  const pkg = parseJsonAs(PackageJson, (await readTextOrNull(join(dir, 'package.json'))) ?? '');
  return {
    name: pkg?.name ?? null,
    deps: new Set(
      [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies].flatMap((d) =>
        Object.keys(d ?? {})
      )
    )
  };
}

/**
 * Member order: a member whose package another member depends on comes
 * before it, members with no order between them keep the order they were
 * found in, members not checked out follow, and the umbrella is last. A
 * cycle keeps the found order.
 */
export async function orderMembers(members: DetectedMember[]): Promise<DetectedMember[]> {
  const rest = members.filter((m) => !m.umbrella);
  const pkgs = await Promise.all(rest.map(async (m) => packageOf(m.dir)));
  const nameOf = new Map(rest.map((m, i) => [m, pkgs[i].name]));
  const needs = new Map(
    rest.map((m, i) => [
      m,
      rest.filter((other) => {
        const name = nameOf.get(other);
        return other !== m && name != null && pkgs[i].deps.has(name);
      })
    ])
  );
  const ordered: DetectedMember[] = [];
  const left = [...rest];
  while (left.length > 0) {
    const next =
      left.find((m) => (needs.get(m) ?? []).every((d) => ordered.includes(d))) ?? left[0];
    ordered.push(next);
    left.splice(left.indexOf(next), 1);
  }
  // A member that is not checked out has no package to read, so its place is unknown: last.
  return [
    ...ordered.filter((m) => m.repo !== null),
    ...ordered.filter((m) => m.repo === null),
    ...members.filter((m) => m.umbrella)
  ];
}

/**
 * The workspace project rooted at `path`, if it is one: an umbrella
 * repository whose `.gitmodules` lists submodules, or a folder that is not a
 * repository with two or more child repositories. Reads files only; nothing
 * runs in any repository.
 */
export async function detectWorkspace(
  path: string,
  deps: DetectDeps
): Promise<DetectedWorkspace | null> {
  const root = await realpath(path).catch(() => null);
  if (root === null) return null;
  const res = await deps.identify(root);
  const umbrella = okRef(res);
  if (umbrella !== null) {
    if (umbrella.root !== root) return null;
    const members = await submodules(umbrella, deps);
    if (members === null) return null;
    return {
      kind: 'submodules',
      project: { repoId: umbrella.repoId, root: umbrella.root, name: umbrella.name },
      members: await orderMembers(members)
    };
  }
  if (res.ok || res.reason !== 'not-a-repo') return null;
  const members = await childRepos(root, deps);
  if (members.length < 2) return null;
  return {
    kind: 'folder',
    project: { repoId: repoIdFor(root), root, name: basename(root) },
    members: await orderMembers(members)
  };
}
