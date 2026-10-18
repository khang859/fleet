import { create } from 'zustand';
import type { AgencyPreflight, AgencyRepoRef } from '../../../shared/agency';
import type { AgencyProjectSummary, BriefIdeas } from '../../../shared/agency-projects';
import { openAdmiral, type OpenAdmiralOutcome } from '../lib/open-admiral';
import { focusPane } from '../lib/focus-pane';
import { createLogger } from '../logger';
import { findAdmiralPane, useWorkspaceStore } from './workspace-store';

const log = createLogger('store:admiral-onboarding');

/**
 * What the Admiral's onboarding screens share between panes: the first-run
 * checks, whether first run was finished, the projects the switcher lists,
 * and each repository's brief ideas. Main owns all of it; this is the
 * renderer's latest read.
 */
type AdmiralOnboardingState = {
  preflight: AgencyPreflight | null;
  checking: boolean;
  /** Null until read from main. */
  firstRunDone: boolean | null;
  /** The client chose to go on without the GitHub CLI for now. Not saved: it is asked again next run. */
  ghSkipped: boolean;
  projects: AgencyProjectSummary[];
  ideas: Partial<Record<string, BriefIdeas>>;
  /** Admiral panes showing the project picker in place of their own screen. */
  picking: Partial<Record<string, true>>;
  /** Admiral panes showing their project's setup again, after it was done. */
  redoingSetup: Partial<Record<string, true>>;
  /** Admiral panes showing the Meet you questions left, after Meet you was finished for later. */
  meeting: Partial<Record<string, true>>;

  checkPreflight: () => Promise<void>;
  loadFirstRun: () => Promise<void>;
  finishFirstRun: () => Promise<void>;
  skipGh: () => void;
  loadProjects: () => Promise<void>;
  loadIdeas: (repo: AgencyRepoRef) => Promise<void>;
  setPicking: (paneId: string, picking: boolean) => void;
  setRedoingSetup: (paneId: string, redoing: boolean) => void;
  setMeeting: (paneId: string, meeting: boolean) => void;
};

export const useAdmiralOnboardingStore = create<AdmiralOnboardingState>((set) => ({
  preflight: null,
  checking: false,
  firstRunDone: null,
  ghSkipped: false,
  projects: [],
  ideas: {},
  picking: {},
  redoingSetup: {},
  meeting: {},

  checkPreflight: async () => {
    set({ checking: true });
    try {
      set({ preflight: await window.fleet.agency.preflight() });
    } catch (err) {
      log.warn('preflight failed', { error: String(err) });
    } finally {
      set({ checking: false });
    }
  },

  loadFirstRun: async () => {
    set({ firstRunDone: await window.fleet.agency.projects.firstRunDone() });
  },

  finishFirstRun: async () => {
    await window.fleet.agency.projects.finishFirstRun();
    set({ firstRunDone: true });
  },

  skipGh: () => set({ ghSkipped: true }),

  loadProjects: async () => {
    try {
      set({ projects: await window.fleet.agency.projects.list() });
    } catch (err) {
      log.warn('project list failed', { error: String(err) });
    }
  },

  loadIdeas: async (repo) => {
    try {
      const ideas = await window.fleet.agency.projects.briefIdeas(repo);
      set((s) => ({ ideas: { ...s.ideas, [repo.repoId]: ideas } }));
    } catch (err) {
      log.warn('brief ideas failed', { repoId: repo.repoId, error: String(err) });
      set((s) => ({ ideas: { ...s.ideas, [repo.repoId]: { ideas: [], github: 'ok' } } }));
    }
  },

  setPicking: (paneId, picking) => set((s) => ({ picking: flagged(s.picking, paneId, picking) })),

  setRedoingSetup: (paneId, redoing) =>
    set((s) => ({ redoingSetup: flagged(s.redoingSetup, paneId, redoing) })),

  setMeeting: (paneId, meeting) => set((s) => ({ meeting: flagged(s.meeting, paneId, meeting) }))
}));

/** A per-pane flag map with one pane's flag set or cleared. */
function flagged(
  flags: Partial<Record<string, true>>,
  paneId: string,
  on: boolean
): Partial<Record<string, true>> {
  const next = { ...flags };
  if (on) next[paneId] = true;
  else delete next[paneId];
  return next;
}

/**
 * The header switcher's move: bring forward the Admiral tab already open for
 * the project, in whichever workspace it is, or open one for it.
 */
export async function switchToProject(repo: AgencyRepoRef): Promise<OpenAdmiralOutcome> {
  const existing = findAdmiralPane(useWorkspaceStore.getState(), repo.repoId);
  if (existing !== null && (await focusPane(existing))) return 'focused';
  return openAdmiral(repo.root);
}
