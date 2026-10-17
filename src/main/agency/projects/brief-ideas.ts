import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { githubSlug, type BriefIdea, type BriefIdeas } from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { ghJson, ghState, type GhRun } from './gh';
import { readOnlyGit, repoFacts } from './repo-reader';

/**
 * Ideas for a first brief, from what the project already says needs doing:
 * open GitHub issues, CI runs failing on the default branch, and the top of
 * the changelog. Each is only a suggestion; picking one fills the brief.
 * Without the GitHub CLI, or signed out, only the changelog speaks.
 */

const MAX_ISSUES = 3;
const RUNS_LOOKED_AT = 20;

const Issues = z.array(z.object({ number: z.number(), title: z.string() }));
const Runs = z.array(
  z.object({
    workflowName: z.string(),
    displayTitle: z.string(),
    conclusion: z.string(),
    headBranch: z.string()
  })
);

async function issueIdeas(gh: GhRun, root: string): Promise<BriefIdea[]> {
  const parsed = Issues.safeParse(
    ghJson(
      await gh(
        [
          'issue',
          'list',
          '--state',
          'open',
          '--limit',
          String(MAX_ISSUES),
          '--json',
          'number,title'
        ],
        root
      )
    )
  );
  if (!parsed.success) return [];
  return parsed.data.map((issue) => ({
    kind: 'issue',
    tag: `Issue #${issue.number}`,
    title: issue.title,
    brief: `Work on GitHub issue #${issue.number}: ${issue.title}`
  }));
}

/**
 * One idea per workflow whose latest run on the default branch failed, or
 * that failed more than once in the runs looked at: failing, or flaky.
 */
async function ciIdeas(gh: GhRun, root: string, branch: string): Promise<BriefIdea[]> {
  const parsed = Runs.safeParse(
    ghJson(
      await gh(
        [
          'run',
          'list',
          '--branch',
          branch,
          '--limit',
          String(RUNS_LOOKED_AT),
          '--json',
          'workflowName,displayTitle,conclusion,headBranch'
        ],
        root
      )
    )
  );
  if (!parsed.success) return [];
  const byWorkflow = new Map<string, typeof parsed.data>();
  for (const run of parsed.data) {
    if (run.conclusion === '') continue; // still running
    byWorkflow.set(run.workflowName, [...(byWorkflow.get(run.workflowName) ?? []), run]);
  }
  const ideas: BriefIdea[] = [];
  for (const [workflow, runs] of byWorkflow) {
    const failed = runs.filter((r) => r.conclusion === 'failure').length;
    const latestFailed = runs[0]?.conclusion === 'failure';
    if (!latestFailed && failed < 2) continue;
    const title = latestFailed
      ? `${workflow} is failing on ${branch}`
      : `${workflow} failed ${failed} of the last ${runs.length} runs on ${branch}`;
    ideas.push({
      kind: 'ci',
      tag: latestFailed ? 'Failing CI' : 'Flaky CI',
      title,
      brief: `${title} (latest run: "${runs[0]?.displayTitle ?? ''}"). Find out why and fix it.`
    });
  }
  return ideas;
}

/** The newest changelog section and its first entry, as something to follow up. */
export function changelogIdea(text: string): BriefIdea | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+\S/.test(l));
  if (start === -1) return null;
  const heading = lines[start].replace(/^##\s+/, '').trim();
  const entry = lines
    .slice(start + 1)
    .find((l, i, rest) => /^[-*]\s+\S/.test(l) && !rest.slice(0, i).some((p) => /^##\s/.test(p)));
  if (entry === undefined) return null;
  const item = entry.replace(/^[-*]\s+/, '').trim();
  return {
    kind: 'changelog',
    tag: 'Changelog',
    title: `Follow up on ${heading}: ${item}`,
    brief: `Look for loose ends in this change from the latest CHANGELOG.md entry (${heading}) and suggest a follow-up: ${item}`
  };
}

export async function briefIdeas(
  root: string,
  deps: { gh: GhRun; git?: GitRun }
): Promise<BriefIdeas> {
  const ideas: BriefIdea[] = [];
  const facts = await repoFacts(root, deps.git ?? readOnlyGit);
  let github: BriefIdeas['github'] = 'no-remote';
  if (githubSlug(facts.remote) !== null) {
    github = await ghState(deps.gh, root);
    if (github === 'ok') {
      const [issues, ci] = await Promise.all([
        issueIdeas(deps.gh, root),
        facts.defaultBranch === null ? [] : ciIdeas(deps.gh, root, facts.defaultBranch)
      ]);
      ideas.push(...issues, ...ci);
    }
  }
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8').catch(() => null);
  const idea = changelog === null ? null : changelogIdea(changelog);
  if (idea !== null) ideas.push(idea);
  return { ideas, github };
}
