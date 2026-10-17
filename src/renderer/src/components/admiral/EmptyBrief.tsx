import { useEffect } from 'react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { BriefIdea, BriefIdeas } from '../../../../shared/agency-projects';
import { useAdmiralOnboardingStore } from '../../store/admiral-onboarding-store';
import { admiralKey } from '../../store/admiral-thread';
import { prefillComposer } from '../agent/composer-events';

/**
 * The lobby before anything has been said: an invitation to brief, in the
 * Admiral's own voice, and ideas drawn from the project - open issues,
 * failing CI and the changelog. Picking one only fills the brief.
 */
export function EmptyBrief({
  paneId,
  repo
}: {
  paneId: string;
  repo: AgencyRepoRef;
}): React.JSX.Element {
  const ideas = useAdmiralOnboardingStore((s) => s.ideas[repo.repoId]);
  const loadIdeas = useAdmiralOnboardingStore((s) => s.loadIdeas);

  // Read each time the lobby comes up empty, so the ideas are as fresh as the project.
  const { repoId, root, name } = repo;
  useEffect(() => {
    void loadIdeas({ repoId, root, name });
  }, [loadIdeas, repoId, root, name]);

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-xl font-semibold text-fleet-text">Ready. What should we work on?</h2>
          <p className="text-[13px] text-fleet-text-muted">
            Tell me what you want, like you would tell a person. I write a plan first, and nothing
            starts until you approve it.
          </p>
        </div>
        <BriefIdeasList
          ideas={ideas}
          onPick={(idea) => prefillComposer(admiralKey(paneId, null), idea.brief)}
        />
      </div>
    </div>
  );
}

const GITHUB_NOTE: Record<BriefIdeas['github'], string | null> = {
  ok: null,
  'no-remote': null,
  'not-installed': 'Install the GitHub CLI to see ideas from open issues and CI runs too.',
  'signed-out': 'Sign in to the GitHub CLI to see ideas from open issues and CI runs too.'
};

/** The brief ideas, each a chip that fills the brief; undefined while they are read. */
export function BriefIdeasList({
  ideas,
  onPick
}: {
  ideas: BriefIdeas | undefined;
  onPick: (idea: BriefIdea) => void;
}): React.JSX.Element {
  const note = ideas === undefined ? null : GITHUB_NOTE[ideas.github];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
        IDEAS FROM THIS PROJECT
      </h3>
      {ideas === undefined ? (
        <p className="text-xs text-fleet-text-subtle">Looking at issues, CI and the changelog…</p>
      ) : ideas.ideas.length === 0 ? (
        <div className="rounded-lg border border-dashed border-fleet-border px-3 py-2.5 text-xs text-fleet-text-subtle">
          Nothing to suggest from this project right now. Describe the work in your own words.
        </div>
      ) : (
        <>
          {ideas.ideas.map((idea) => (
            <button
              key={`${idea.kind}:${idea.title}`}
              type="button"
              onClick={() => onPick(idea)}
              title={idea.brief}
              className="flex items-center gap-2.5 rounded-lg border border-fleet-border bg-fleet-surface px-3 py-2 text-left transition hover:border-fleet-border-strong hover:bg-fleet-surface-2 active:scale-[0.99] focus-ring"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ${IDEA_TONE[idea.kind]}`}
              >
                {idea.tag}
              </span>
              <span className="min-w-0 flex-1 text-[13px] text-fleet-text">{idea.title}</span>
            </button>
          ))}
          <p className="text-[11px] text-fleet-text-subtle">
            From the project&apos;s issues, CI runs and changelog. Picking one only fills in the
            brief.
          </p>
        </>
      )}
      {note !== null && <p className="text-[11px] text-fleet-text-subtle">{note}</p>}
    </section>
  );
}

const IDEA_TONE: Record<BriefIdea['kind'], string> = {
  issue: 'bg-fleet-surface-2 text-fleet-text-muted',
  ci: 'bg-red-500/10 text-red-600 dark:text-red-400',
  changelog: 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
};

/** A job's conversation before anything is in it. */
export function EmptyJob({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <span className="text-sm font-medium text-fleet-text-secondary">{title}</span>
      <span className="text-xs text-fleet-text-muted">
        Everything about this job happens in this tab.
      </span>
    </div>
  );
}
