import type { CrewRuntime } from './agency-crew';
import type { CrewLesson } from './agency-lessons';
import type { SettingsCard } from './agency-settings';
import type { MeetQuestionId } from './agency-meet';
import type { ProjectTrust } from './agency-projects';
import { PERMISSION_EXPIRY_SEC_DEFAULT } from './agency-permissions';

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
      /** Null for a project that is a folder of repositories, which has no git directory of its own. */
      gitCommonDir: string | null;
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

/**
 * What keeps a running job `waiting`: the model cannot be reached, it took
 * too many automatic turns in a row, it hit its budget or the monthly cap,
 * or every remaining step waits on the client. The job runs again once every
 * hold is gone.
 */
export type JobHoldKind = 'model' | 'chain_limit' | 'budget' | 'client';

export type AgencyJob = {
  id: number;
  repoId: string;
  title: string;
  brief: string;
  state: JobState;
  /** The plan version in force, or null before the first approval. */
  approvedVersion: number | null;
  /** How a `closing` job ends once cleanup is done. */
  closeTarget: 'closed' | 'cancelled' | 'failed' | null;
  /** Automatic Admiral turns in a row since the last client action or finished step. */
  chainCount: number;
  /** The closed job this one follows up on. */
  linkedJobId: number | null;
  holds: JobHoldKind[];
  /** A plan version waiting on the client, or null when none is. */
  pendingPlan: { id: number; version: number } | null;
  /** Crew members waiting on the client in their pane, at a login or trust screen. */
  crewNeedingYou: number;
  /** Crew permission requests waiting on the client, on a card or in the crew pane, by id. */
  permissionsWaiting: number[];
  /** The agent session the job's conversation is written to. */
  sessionId: string;
  /** Whether the lobby messages that led to this job were carried into it. */
  handoffDone: boolean;
  budgetUsd: number | null;
  /** The approved plan's share of the weekly Claude limit, in percent. */
  budgetWeekPct: number | null;
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

/**
 * `ask` is the Admiral's own question. The rest are Fleet's cards, answered
 * the same way: `model_unreachable` (Retry or Settings), `continue` (go on
 * after the automatic-turn limit), `resume` (Resume or Cancel after a
 * restart), `rehire` (hire for a step again after its crew member left) and
 * `budget` (raise the budget or the monthly cap, or stop the job).
 */
export type AgencyQuestionKind =
  | 'ask'
  | 'client_file'
  | 'model_unreachable'
  | 'continue'
  | 'resume'
  | 'rehire'
  | 'budget'
  | 'crew_lesson';

export const AGENCY_QUESTION_KINDS: readonly AgencyQuestionKind[] = [
  'ask',
  'client_file',
  'model_unreachable',
  'continue',
  'resume',
  'rehire',
  'budget',
  'crew_lesson'
];

/** The kinds the Admiral puts up itself, whose answers wake it; the rest are Fleet's own cards. */
export const ADMIRAL_QUESTION_KINDS: readonly AgencyQuestionKind[] = ['ask', 'client_file'];

/**
 * A line the Admiral wants in the client file. `replaces` is an existing line
 * it contradicts: the card shows both, and the old one goes only on approval.
 */
export type ClientFileAddition = { text: string; replaces: string | null };

/**
 * What a `budget` card raises when the client picks Raise: the job's dollar
 * budget, its share of the weekly Claude limit, or the monthly cap.
 */
export type BudgetRaise = { target: 'usd' | 'week_pct' | 'cap'; to: number };

/** A Remember this? card's options, in the order the card shows them. */
export const REMEMBER_OPTION = { project: 0, all: 1, decline: 2 } as const;

/** Which client file a card writes: the project's, or the You file for every project. */
export type ClientLayerPick = 'project' | 'you';

/**
 * What a `client_file` card asks to change in the client file. A card with
 * a `topic` is a Remember this? card: one new line, which the client saves
 * for this project or all of them, or declines for the topic.
 */
export type ClientFileProposal = {
  add: ClientFileAddition[];
  remove: string[];
  topic: string | null;
  /** The layer the Admiral suggests, which the card marks as its pick. */
  layer: ClientLayerPick;
};

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
  /** What a `client_file` card would change; null for every other kind. */
  proposal: ClientFileProposal | null;
  /** What a `budget` card raises; null for every other kind. */
  raise: BudgetRaise | null;
  /** What a `crew_lesson` card would change in a role; null for every other kind. */
  lesson: CrewLesson | null;
  /** Answered after it was withdrawn: kept, and the Admiral is told it came late. */
  late: boolean;
  withdrawnReason: string | null;
  createdAt: number;
  answeredAt: number | null;
};

/**
 * Something a job made that cleanup has to undo. Recorded before it is made,
 * so a crash in between still leaves a row to clean.
 */
export type ResourceKind =
  | 'crew_pane'
  | 'compose_project'
  | 'member_worktree'
  | 'umbrella_worktree'
  | 'workspace_dir';

/**
 * What cleanup left behind: kept on purpose, since there is work in it, or
 * not undone, since a step failed. It stays listed until it is cleaned or the
 * client dismisses it.
 */
export type AgencyLeftover = {
  id: number;
  jobId: number;
  kind: ResourceKind;
  label: string;
  path: string | null;
  status: 'kept' | 'failed';
  detail: string;
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
  /** How far the repository got through onboarding. */
  onboarding: AgencyOnboarding;
  /** What closed jobs' cleanup kept or could not undo, until cleaned or dismissed. */
  leftovers: AgencyLeftover[];
  /** The client file changed outside Fleet since Fleet last wrote it, and the client has not kept it yet. */
  clientFileChanged: boolean;
  /** How much Fleet does on its own in this project. */
  trust: ProjectTrust;
  /** The last closed, cancelled or failed jobs, newest first, for export. */
  pastJobs: AgencyJob[];
  /** The newest settings cards the Admiral put up, oldest first. */
  settingsCards: SettingsCard[];
  /** The client's decisions since local midnight, newest first, for Done today. */
  decisions: ClientDecision[];
  /** Decisions from the Bridge that Fleet holds a few seconds, so the client can undo them. */
  held: HeldDecision[];
};

/** One decision the client made today, for the Bridge's Done today list. */
export type ClientDecision = {
  /** The queue item it decided: `plan:12`, `q:35`, `perm:7`. */
  key: string;
  jobId: number | null;
  /** What the client did: `Approved plan v2`, `Answered q35`, `Allowed once`. */
  label: string;
  /** What it was about: the answer, the command, the client's note. */
  detail: string | null;
  /** Where the job stands now; null for a lobby question. */
  jobState: JobState | null;
  at: number;
};

/** A decision from the Bridge that Fleet carries out when `runsAt` comes, unless undone. */
export type HeldDecision = {
  id: number;
  jobId: number | null;
  /** The queue item it decides: `plan:12`, `q:35`. */
  key: string;
  /** What it does, for the line that stands in for the item: `Approved plan v1`. */
  label: string;
  runsAt: number;
};

/** When a repository's setup and starter questions were finished; null while they are not. */
export type AgencyOnboarding = {
  setupDoneAt: number | null;
  /** When the project finished Meet you, or the starter questions before it. */
  starterDoneAt: number | null;
  /**
   * Meet you shows before the Bridge: the project has not finished it, or
   * Meet you never ran for the You questions.
   */
  meetDue: boolean;
  /** The Meet you questions left for this project, You ones included. */
  meetLeft: MeetQuestionId[];
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
  /** Set when a setting was written, so Settings reads it again. */
  settings?: true;
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

/**
 * A question's options as numbered lines, for the model: `1. label - detail`,
 * with the recommended one marked by `pickNote`.
 */
export function optionLines(
  q: Pick<AgencyQuestion, 'options' | 'recommended'>,
  pickNote: string
): string[] {
  return q.options.map((o, i) => {
    const detail = o.detail ? ` - ${o.detail}` : '';
    const pick = q.recommended === i ? ` (${pickNote})` : '';
    return `${i + 1}. ${o.label}${detail}${pick}`;
  });
}

export type AgencySettings = {
  /** Everything Admiral is off until this is on. */
  enabled: boolean;
  admiral: {
    /** Empty runs the Admiral on the Agent's coding model. */
    model: string;
    /** What a new job may spend unless its plan says otherwise. */
    defaultBudgetUsd: number;
    /** The share of the weekly Claude limit a new job may use unless its plan says otherwise, in percent. */
    defaultBudgetWeekPct: number;
    /** What all jobs together may spend in a calendar month, from 00:00 on the 1st in local time. */
    monthlyCapUsd: number;
    /** No new Claude crew work starts while Claude Code's 5-hour window is at or above this percentage. */
    reserveFiveHourPct: number;
    /** No new Claude crew work starts while Claude Code's weekly limit is at or above this percentage. */
    reserveSevenDayPct: number;
    /** How many times the Admiral may nudge a crew member that ends a turn without reporting. */
    nudgeLimit: number;
    /** How many automatic Admiral turns a job takes in a row before it asks the client to continue. */
    turnLimit: number;
    /** How long a client permission card waits before it is denied, in seconds. */
    permissionExpirySec: number;
  };
  /** Settings › Agency › Crew › Runtimes, for each runtime. */
  crew: Record<CrewRuntime, CrewRuntimeSettings>;
};

export type CrewRuntimeSettings = {
  /** The most crew of the runtime that work at once, across jobs; null takes `defaultAtOnce`. */
  atOnce: number | null;
  /** The model of a role that names none; empty leaves it to the runtime. */
  defaultModel: string;
};

export const DEFAULT_AGENCY_SETTINGS: AgencySettings = {
  enabled: true,
  admiral: {
    model: '',
    defaultBudgetUsd: 10,
    defaultBudgetWeekPct: 10,
    monthlyCapUsd: 100,
    reserveFiveHourPct: 80,
    reserveSevenDayPct: 90,
    nudgeLimit: 3,
    turnLimit: 20,
    permissionExpirySec: PERMISSION_EXPIRY_SEC_DEFAULT
  },
  crew: {
    claude: { atOnce: null, defaultModel: '' },
    eva: { atOnce: null, defaultModel: '' }
  }
};
