/**
 * The Admiral agency, as every process sees it: the repository an Admiral is
 * bound to, the jobs it runs there, the questions it puts to the client, and
 * the wakeups that bring it back to a job. Main owns the durable copy in
 * `~/.fleet/agency.db`; the renderer reads it through `window.fleet.agency`.
 */

/**
 * What a folder resolves to. `repoId` is a hash of the realpath of the git
 * common dir, so the main checkout and every linked worktree of it are one
 * repository. A submodule has its own common dir under the superproject's
 * `.git/modules/`, so it is its own repository, and says which one holds it.
 */
export type RepoResolution =
  | {
      ok: true;
      repoId: string;
      /** The main checkout's working tree, even when resolved from a worktree. */
      root: string;
      name: string;
      gitCommonDir: string;
      /** The superproject's working tree when this repository is a submodule. */
      superprojectRoot: string | null;
      /** The superproject's own `repoId`, so its Admiral can be found from a submodule. */
      superprojectRepoId: string | null;
    }
  | { ok: false; reason: 'not-a-repo' | 'remote' };

/** Which Admiral conversation a turn is: a repository's lobby (`jobId` null) or one job. */
export type AdmiralThreadScope = { repoId: string; jobId: number | null };

/** The part of a resolution an Admiral pane keeps on its leaf. */
export type AgencyRepoRef = { repoId: string; root: string; name: string };

export type JobState =
  | 'briefing'
  | 'planned'
  | 'running'
  | 'waiting'
  | 'delivered'
  | 'closing'
  | 'closed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

/**
 * The states in which a job has work under way that closing its pane or
 * quitting Fleet would leave unattended. `briefing` is not one: a job still
 * being briefed is a conversation, and nothing runs for it yet.
 */
export const RUNNING_JOB_STATES: readonly JobState[] = [
  'planned',
  'running',
  'waiting',
  'delivered',
  'interrupted'
];

/** States a job does not leave. A snapshot leaves them out of the job tabs. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['closed', 'cancelled', 'failed'];

export type AgencyJob = {
  id: number;
  repoId: string;
  title: string;
  brief: string;
  state: JobState;
  /** The agent session the job's conversation is written to. */
  sessionId: string;
  /** Whether the lobby messages that led to this job were carried into it. */
  handoffDone: boolean;
  budgetUsd: number | null;
  createdAt: number;
  updatedAt: number;
};

export type AgencyJobEvent = {
  jobId: number;
  at: number;
  from: JobState | null;
  to: JobState;
  reason: string;
};

export type AgencyQuestionOption = { label: string; detail?: string };

export type AgencyQuestionKind = 'ask' | 'model_unreachable';

/**
 * `hidden` is a question that depends on another one's answer and is not
 * shown until that answer picks the option it depends on.
 */
export type AgencyQuestionStatus = 'open' | 'hidden' | 'answered' | 'withdrawn';

export type AgencyQuestion = {
  id: number;
  repoId: string;
  /** Null for a question asked in the lobby, before there is a job. */
  jobId: number | null;
  planVersion: number | null;
  step: string | null;
  kind: AgencyQuestionKind;
  question: string;
  context: string;
  options: AgencyQuestionOption[];
  /** Index into `options` of the Admiral's own pick. */
  recommended: number | null;
  dependsOn: { question: number; option: number } | null;
  status: AgencyQuestionStatus;
  answerOption: number | null;
  answerText: string | null;
  /** Answered after it was withdrawn: kept, and the Admiral is told it came late. */
  late: boolean;
  withdrawnReason: string | null;
  createdAt: number;
  answeredAt: number | null;
};

export type AgencySnapshot = {
  repoId: string;
  /** Empty until `ensureLobby` has run for the repository. */
  lobbySessionId: string;
  /** Jobs not yet closed, cancelled or failed, oldest first. */
  jobs: AgencyJob[];
  /** Open questions, and the most recently answered or withdrawn ones. */
  questions: AgencyQuestion[];
  /** When the next model retry is due, or null when none is waiting. */
  nextRetryAt: number | null;
};

/**
 * What one pull hands back: the wakeups it claimed, as one text for one turn,
 * and when the next one not yet due becomes due.
 */
export type WakeupPull = { ids: number[]; text: string | null; nextDueAt: number | null };

export type WakeupRelease = { nextDueAt: number | null; gaveUp: boolean };

/** Told to the renderer whenever agency state for a repository changes. */
export type AgencyChanged = {
  repoId: string;
  /** The jobs that changed; null stands for the lobby. */
  jobIds: Array<number | null>;
  /** Set when a job was just opened from the lobby, for the handoff. */
  openedJobId?: number;
};

export type AdmiralClaimResult = { ok: true } | { ok: false; ownerPaneId: string };

export type AgencyAnswerRequest = { id: number; option?: number; text?: string };

/**
 * What the first-run screen checks. Presence only: a key is reported as there
 * or not, and no credential leaves main.
 */
export type AgencyPreflight = {
  /** An OpenRouter key is saved, or a local model endpoint is configured. */
  modelKey: boolean;
  claude: { found: boolean; version: string | null };
  eva: { found: boolean; version: string | null };
  gh: { found: boolean; signedIn: boolean };
};

/** How a job id is shown to the client and the model: `j12`. */
export const jobDisplayId = (n: number): string => `j${n}`;

/** How a question id is shown: `q7`. */
export const questionDisplayId = (n: number): string => `q${n}`;

export type AgencySettings = {
  /** Everything Admiral is off until this is on. */
  enabled: boolean;
  admiral: {
    /** Empty runs the Admiral on the Agent's coding model. */
    model: string;
    /** What a new job may spend unless its plan says otherwise. */
    defaultBudgetUsd: number;
    /** What all jobs together may spend in a calendar month. */
    monthlyCapUsd: number;
  };
};

export const DEFAULT_AGENCY_SETTINGS: AgencySettings = {
  enabled: false,
  admiral: { model: '', defaultBudgetUsd: 10, monthlyCapUsd: 100 }
};
