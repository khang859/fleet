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
  type CrewSource,
  type RoleDraft,
  type RoleSaveResult
} from '../../../shared/agency-crew';
import type { NewRole, Plan } from '../../../shared/agency-plan';
import { createLogger } from '../../logger';
import { loadDefinitions } from '../../agent/markdown-definitions';
import { writeFrontmatterFile } from '../../agent/markdown-definitions-write';
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
  return `---\n${stringifyYaml(roleFront(role))}---\n\n${role.instructions.trim()}\n`;
}

/** A role's frontmatter as its file writes it, leaving out the keys at their defaults. */
function roleFront({ name, description, runtime, model, stack }: NewRole): Record<string, unknown> {
  return { name, description, runtime, ...(model && { model }), ...(stack && { stack }) };
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

/** Where Settings saves roles: the user's crew folder, and the project's. */
export type RoleSaveDirs = { user: string | null; project: string };

/** The file a role saves to: its own, else the user's folder for a bundled role. */
function roleTarget(
  known: CrewRole,
  crew: CrewCatalog,
  dirs: RoleSaveDirs
): { path: string } | { refused: string } {
  if (known.source !== 'bundled') return { path: known.path };
  if (dirs.user === null) return { refused: 'Fleet has no user crew folder to save the role in.' };
  const path = join(dirs.user, 'roles', `${known.name}.md`);
  const other = crew.roles.find((r) => r.path === path && r.name !== known.name);
  return other === undefined
    ? { path }
    : { refused: `${path} holds the role ${other.name}. Rename that file first.` };
}

/**
 * Save a role from Settings in the file it came from. A bundled role is saved
 * as the user's own, which then replaces it; a new role goes in the project.
 * A file that changed since the editor loaded it is not overwritten.
 */
export async function saveRole(
  crew: CrewCatalog,
  dirs: RoleSaveDirs,
  { base, role }: { base: RoleDraft | null; role: RoleDraft }
): Promise<RoleSaveResult> {
  const known = crew.roles.find((r) => r.name === role.name);
  let target: { path: string } | { refused: string };
  if (base === null) {
    target =
      known === undefined
        ? { path: join(dirs.project, 'roles', `${role.name}.md`) }
        : { refused: `A crew role named ${role.name} is already there. Pick another name.` };
  } else if (base.name !== role.name) {
    target = { refused: 'A role keeps its name. Make a new role for another name.' };
  } else if (known === undefined) {
    target = { refused: `The role ${role.name} is gone. Open the page again.` };
  } else if (roleFileText(asNewRole(known)) !== roleFileText(base)) {
    target = { refused: `${known.path} changed outside Fleet. Discard, then edit it again.` };
  } else {
    target = roleTarget(known, crew, dirs);
  }
  if ('refused' in target) return { ok: false, reason: target.refused };
  try {
    await writeFrontmatterFile<Record<string, unknown>>(
      target.path,
      roleFront(role),
      role.instructions,
      RoleFrontmatter,
      'role'
    );
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, path: target.path };
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
