import { homedir } from 'node:os';
import { join } from 'node:path';
import { YOU_LAYER } from '../../../shared/agency-client-file';

/**
 * Where the agency keeps per-project files: `~/.fleet/agency/`, or
 * `FLEET_AGENCY_HOME` for tests and for driving the app against a scratch
 * folder.
 */
export function agencyHome(): string {
  return process.env.FLEET_AGENCY_HOME ?? join(homedir(), '.fleet', 'agency');
}

/** A job's folder: its delivered files and its workspaces, outside every checkout. */
export function jobDir(home: string, jobId: number): string {
  return join(home, 'jobs', String(jobId));
}

/**
 * A project's folder. It mirrors a repository's `.fleet/` layout, so "Share
 * with team" is a copy into the main checkout and an import is a copy back.
 */
export function projectDir(repoId: string, home: string = agencyHome()): string {
  return join(home, 'projects', repoId);
}

export const SETUP_FILE = 'fleet.agency.toml';

export function setupFilePath(repoId: string, home: string = agencyHome()): string {
  return join(projectDir(repoId, home), SETUP_FILE);
}

/** A layer of client preferences: the You file for every project, or one project's client file. */
export function clientFilePath(layer: string, home: string = agencyHome()): string {
  return layer === YOU_LAYER ? join(home, 'you.md') : join(home, 'clients', `${layer}.md`);
}
