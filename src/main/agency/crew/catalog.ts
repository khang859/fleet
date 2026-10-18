import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  checkPlaybook,
  PlaybookFrontmatter,
  RoleFrontmatter,
  type CrewCatalog,
  type CrewFileError,
  type CrewRole,
  type CrewSnapshot,
  type CrewSource
} from '../../../shared/agency-crew';
import type { NewRole, Plan } from '../../../shared/agency-plan';
import { createLogger } from '../../logger';
import { loadDefinitions } from '../../agent/markdown-definitions';
import { projectDir } from '../projects/paths';

const log = createLogger('agency:crew');

/**
 * The two crew folders outside a project: the ones Fleet ships and the
 * user's `~/.fleet/crew/`. Null leaves one out, as tests do.
 */
export type CrewDirs = { bundled: string | null; user: string | null };

export const NO_CREW_DIRS: CrewDirs = { bundled: null, user: null };

/** A project's own crew folder, beside its saved setup. */
export function projectCrewDir(repoId: string, home: string): string {
  return join(projectDir(repoId, home), 'crew');
}

/** The folders a project's crew is read from, least specific first. */
export function crewSources(dirs: CrewDirs, projectCrew: string): Array<[CrewSource, string]> {
  const sources: Array<[CrewSource, string]> = [];
  if (dirs.bundled !== null) sources.push(['bundled', dirs.bundled]);
  if (dirs.user !== null) sources.push(['user', dirs.user]);
  sources.push(['project', projectCrew]);
  return sources;
}

/**
 * Every role and playbook in `sources`, a later source winning a repeated
 * name. A playbook that names a missing role or waits in a loop is left out
 * and listed in `errors`, beside the files that did not parse.
 */
export async function loadCrew(sources: Array<[CrewSource, string]>): Promise<CrewCatalog> {
  const errors: CrewFileError[] = [];
  const onSkip = (e: CrewFileError): void => void errors.push(e);
  const at = (sub: string): Array<[CrewSource, string]> =>
    sources.map(([source, dir]) => [source, join(dir, sub)]);
  const roles = await loadDefinitions(at('roles'), {
    kind: 'role',
    schema: RoleFrontmatter,
    log,
    onSkip,
    build: ({ frontmatter, body, source, path }) => ({
      ...frontmatter,
      prompt: body,
      source,
      path
    })
  });
  const all = await loadDefinitions(at('playbooks'), {
    kind: 'playbook',
    schema: PlaybookFrontmatter,
    log,
    onSkip,
    build: ({ frontmatter, body, source, path }) => ({
      ...frontmatter,
      notes: body,
      source,
      path
    })
  });
  const names = new Set(roles.map((r) => r.name));
  const playbooks = all.filter((p) => {
    const problems = checkPlaybook(p, names);
    if (problems.length > 0)
      errors.push({ source: p.source, path: p.path, why: problems.join(' ') });
    return problems.length === 0;
  });
  return { roles, playbooks, errors };
}

/** A role as its file says it: the frontmatter block, then the instructions. */
export function roleFileText(role: NewRole): string {
  const { name, description, runtime, model, stack } = role;
  const front = { name, description, runtime, ...(model && { model }), ...(stack && { stack }) };
  return `---\n${stringifyYaml(front)}---\n\n${role.instructions.trim()}\n`;
}

/** A loaded role as the new role that would write the same file. */
export const asNewRole = (role: CrewRole): NewRole => ({ ...role, instructions: role.prompt });

/**
 * Write a plan's new roles into the project's crew folder, on the client's
 * approval. A role the crew already has with the same text counts as saved;
 * one with that name that says something else refuses the lot, before any
 * file is written.
 */
export async function saveNewRoles(
  projectCrew: string,
  roles: NewRole[],
  crew: CrewCatalog
): Promise<{ saved: string[] } | { refused: string }> {
  const fresh: NewRole[] = [];
  for (const role of roles) {
    const known = crew.roles.find((r) => r.name === role.name);
    if (known === undefined) fresh.push(role);
    else if (roleFileText(asNewRole(known)) !== roleFileText(role)) {
      return {
        refused: `A crew role named ${role.name} now says something else. Check the plan again.`
      };
    }
  }
  const dir = join(projectCrew, 'roles');
  await mkdir(dir, { recursive: true });
  for (const role of fresh) {
    await writeFile(join(dir, `${role.name}.md`), roleFileText(role), { flag: 'wx' });
  }
  return { saved: fresh.map((r) => r.name) };
}

const hashOf = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The roles a plan's steps use and the playbook it names, as `crew` has them
 * now, each with a hash of what it said. A playbook the catalog does not have
 * is a plan the Admiral wrote from scratch, so it snapshots as null.
 */
export function crewSnapshot(crew: CrewCatalog, plan: Plan): CrewSnapshot {
  const used = new Set(plan.steps.map((s) => s.role));
  const playbook = crew.playbooks.find((p) => p.name === plan.playbook) ?? null;
  return {
    roles: crew.roles.filter((r) => used.has(r.name)).map((r) => ({ ...r, sha256: hashOf(r) })),
    playbook: playbook === null ? null : { ...playbook, sha256: hashOf(playbook) }
  };
}
