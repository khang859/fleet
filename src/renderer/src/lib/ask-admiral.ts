import type { AgencyRepoRef } from '../../../shared/agency';
import { askAdmiral, dropAsks } from '../store/admiral-runtime';
import { openAdmiral, type OpenAdmiralOutcome } from './open-admiral';

/** What the Admiral reads: the page in front, so it knows what the client was looking at. */
export const askText = (page: string, request: string): string => `From ${page}: ${request}`;

/**
 * Open a project's Admiral with a request written on a Settings page or in
 * project setup. The request goes to the lobby once the pane is ready, and is
 * dropped when the Admiral will not open.
 */
export async function askAdmiralFrom(
  page: string,
  repo: AgencyRepoRef,
  request: string
): Promise<OpenAdmiralOutcome> {
  askAdmiral(repo.repoId, askText(page, request));
  try {
    const outcome = await openAdmiral(repo.root);
    if (outcome === 'refused') dropAsks(repo.repoId);
    return outcome;
  } catch (err) {
    dropAsks(repo.repoId);
    throw err;
  }
}
