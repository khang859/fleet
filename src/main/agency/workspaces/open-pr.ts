import { z } from 'zod';
import { ghJson, type GhRun } from '../projects/gh';
import type { GitWrite } from './job-workspace';

export type OpenPrInput = {
  /** The member's checkout, where git and gh run. */
  root: string;
  branch: string;
  /** The member's default branch: the PR's base, and never pushed. */
  base: string;
  title: string;
  body: string;
  draft: boolean;
};

export type OpenPrResult = { ok: true; url: string } | { ok: false; reason: string };

const OpenPrView = z.object({ url: z.string(), state: z.string() });

/**
 * Push a crew branch to `origin` and open its PR, or push to the open PR it
 * already has, as after a fix for review comments. Crew never push or open
 * PRs: Fleet does it here, after the step. The default branch is never pushed.
 */
export async function pushAndOpenPr(
  input: OpenPrInput,
  deps: { git: GitWrite; gh: GhRun }
): Promise<OpenPrResult> {
  const { root, branch, base } = input;
  if (branch === base) return { ok: false, reason: `${branch} is the default branch` };

  const pushed = await deps.git(['push', '--quiet', '-u', 'origin', `${branch}:${branch}`], root);
  if (pushed === null) return { ok: false, reason: `git could not push ${branch} to origin` };

  const open = await openPrOf(branch, root, deps.gh);
  if (open !== null) return { ok: true, url: open };

  const args = ['pr', 'create', '--head', branch, '--base', base];
  args.push('--title', input.title, '--body', input.body);
  if (input.draft) args.push('--draft');
  const out = await deps.gh(args, root);
  const url = out?.code === 0 ? out.stdout.trim().split('\n').at(-1) : undefined;
  return url ? { ok: true, url } : { ok: false, reason: `gh could not open a PR for ${branch}` };
}

/** The URL of the open PR whose head is `branch`, or null when it has none. */
async function openPrOf(branch: string, root: string, gh: GhRun): Promise<string | null> {
  const view = OpenPrView.safeParse(
    ghJson(await gh(['pr', 'view', branch, '--json', 'url,state'], root))
  );
  return view.success && view.data.state === 'OPEN' ? view.data.url : null;
}
