import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { AgencyRepoRef } from '../../../shared/agency';
import {
  ProjectSetupSchema,
  type ProjectImport,
  type ProjectMemberSetup,
  type ProjectSetup
} from '../../../shared/agency-projects';
import { isRecord } from '../../../shared/is-record';
import { readTextOrNull, writeAtomic } from './files';
import { agencyHome, projectDir, SETUP_FILE, setupFilePath } from './paths';

/**
 * A project's saved setup, `~/.fleet/agency/projects/<repoId>/fleet.agency.toml`,
 * and the crew files imported beside it.
 *
 * Fleet keeps it, not the repository, so setup needs no commit and nobody
 * with push access changes how crew work. The file names no machine path, so
 * "Share with team" can hand the same file to a teammate as it is.
 */

const HEADER = [
  '# Fleet agency setup. Fleet saves this file from the Admiral setup screen;',
  '# you can edit it by hand too. Shared copies live in a repository at .fleet/.',
  ''
].join('\n');

type TomlMember = Record<string, unknown>;

function memberToToml(m: ProjectMemberSetup): TomlMember {
  // TOML has no null: a value not known is a key left out.
  return Object.fromEntries(
    Object.entries({
      name: m.name,
      path: m.path,
      remote: m.remote,
      default_branch: m.defaultBranch,
      stack: m.stack,
      package_manager: m.packageManager,
      setup_command: m.setupCommand,
      setup_timeout_sec: m.setupTimeoutSec,
      check_commands: m.checkCommands,
      checks: m.checks,
      required_checks: m.requiredChecks,
      review_bots: m.reviewBots
    }).filter(([, v]) => v !== null)
  );
}

function memberFromToml(t: TomlMember): unknown {
  return {
    name: t.name,
    path: t.path ?? '.',
    remote: t.remote ?? null,
    defaultBranch: t.default_branch ?? null,
    stack: t.stack ?? [],
    packageManager: t.package_manager ?? null,
    setupCommand: t.setup_command ?? '',
    setupTimeoutSec: t.setup_timeout_sec ?? 600,
    checkCommands: t.check_commands ?? [],
    checks: t.checks ?? [],
    requiredChecks: t.required_checks ?? [],
    reviewBots: t.review_bots ?? []
  };
}

export function setupToToml(setup: ProjectSetup): string {
  return (
    HEADER +
    stringifyToml({
      version: setup.version,
      kind: setup.kind,
      name: setup.name,
      members: setup.members.map(memberToToml),
      imports: setup.imports.map((i) => ({ path: i.path, kind: i.kind, sha256: i.sha256 }))
    })
  );
}

/** A setup file's contents, or null when it is not TOML or not a setup Fleet can use. */
export function parseSetupToml(text: string): ProjectSetup | null {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text);
  } catch {
    return null;
  }
  const members = Array.isArray(raw.members) ? raw.members.filter(isRecord) : [];
  const parsed = ProjectSetupSchema.safeParse({
    version: raw.version,
    kind: raw.kind ?? 'repo',
    name: raw.name,
    members: members.map(memberFromToml),
    imports: Array.isArray(raw.imports) ? raw.imports : []
  });
  return parsed.success ? parsed.data : null;
}

export async function loadSetup(
  repoId: string,
  home: string = agencyHome()
): Promise<ProjectSetup | null> {
  const text = await readTextOrNull(setupFilePath(repoId, home));
  return text === null ? null : parseSetupToml(text);
}

/**
 * Where an imported repository file lives in the project folder: a `.fleet/`
 * file at the same place under it, an agent definition under `crew/agents/`
 * until roles can be made from it.
 */
export function importDestination(path: string): string | null {
  if (path.startsWith('.fleet/') && path !== `.fleet/${SETUP_FILE}`)
    return path.slice('.fleet/'.length);
  if (/^\.(claude|opencode)\/agents\/[^/]+\.md$/.test(path))
    return join('crew', 'agents', basename(path));
  return null;
}

/** A repository file the client chose to import, with the content setup read. */
export type ImportedFile = ProjectImport & { content: string };

/** Save a project's setup and copy in the files the client imported. */
export async function saveSetup(
  input: { repo: AgencyRepoRef; setup: ProjectSetup; imported: ImportedFile[] },
  home: string = agencyHome()
): Promise<{ path: string; setup: ProjectSetup }> {
  const dir = projectDir(input.repo.repoId, home);
  for (const file of input.imported) {
    const dest = importDestination(file.path);
    if (dest !== null) await writeAtomic(join(dir, dest), file.content);
  }
  const setup: ProjectSetup = {
    ...input.setup,
    imports: input.imported.map(({ path, kind, sha256 }) => ({ path, kind, sha256 }))
  };
  const path = setupFilePath(input.repo.repoId, home);
  await writeAtomic(path, setupToToml(setup));
  return { path, setup };
}

/**
 * "Share with team": copy the saved setup and its crew files into `.fleet/`
 * in the main checkout. Nothing is staged or committed; the client decides
 * whether the team gets it.
 */
export async function shareWithTeam(
  repo: AgencyRepoRef,
  home: string = agencyHome()
): Promise<string[]> {
  const dir = projectDir(repo.repoId, home);
  const target = join(repo.root, '.fleet');
  const written: string[] = [];
  await mkdir(target, { recursive: true });
  await cp(join(dir, SETUP_FILE), join(target, SETUP_FILE));
  written.push(`.fleet/${SETUP_FILE}`);
  if (existsSync(join(dir, 'crew'))) {
    await cp(join(dir, 'crew'), join(target, 'crew'), { recursive: true });
    written.push('.fleet/crew/');
  }
  return written;
}
