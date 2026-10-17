import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  checkPlaybook,
  PlaybookFrontmatter,
  RoleFrontmatter,
  type CrewCatalog,
  type CrewFileError,
  type CrewSnapshot,
  type CrewSource
} from '../../../shared/agency-crew';
import type { Plan } from '../../../shared/agency-plan';
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
