import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell, type WebContents } from 'electron';
import { z } from 'zod';
import type {
  AdmiralClaimResult,
  AgencyPreflight,
  AgencyQuestion,
  AgencyRepoRef,
  AgencySnapshot,
  RepoResolution,
  WakeupPull,
  WakeupRelease
} from '../../shared/agency';
import {
  ProjectSetupSchema,
  type AgencyProjectSummary,
  type ClientFileView,
  type ClientLineResult,
  type BriefIdeas,
  type ProjectFolder,
  type RuleCandidates,
  type ImportDiff,
  type ProjectTrust,
  type SetupScan,
  TRUST_LEVELS
} from '../../shared/agency-projects';
import { YOU_LAYER } from '../../shared/agency-client-file';
import { MEET_QUESTION_IDS, MEET_TEXT_MAX } from '../../shared/agency-meet';
import {
  CREW_RUNTIMES,
  RoleSaveSchema,
  type CrewCatalog,
  type CrewRuntimeView,
  type RoleSaveResult,
  type RuntimeTestResult
} from '../../shared/agency-crew';
import type { AgencyJobDetail, JobControlResult, PlanActionResult } from '../../shared/agency-jobs';
import type { PermissionAnswerResult } from '../../shared/agency-permissions';
import { PlanSchema } from '../../shared/agency-plan';
import type { AdmiralSettingMark, SettingsUndoOutcome } from '../../shared/agency-settings';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { AgencyService } from './index';

/**
 * The renderer's way into the agency. Every argument is parsed here, in main,
 * before it reaches the store: a value that arrived over IPC is untrusted
 * input, and these write the durable record of what the client decided.
 */

const RepoId = z.string().regex(/^[0-9a-f]{16}$/);
/** A layer of the client's preferences: the You layer or a project's. */
const Layer = z.union([z.literal(YOU_LAYER), RepoId]);
const PaneId = z.string().min(1);
const JobId = z.number().int().positive();
const CrewId = z.number().int().positive();
const Ids = z.array(z.number().int().positive());

const PathContextArg = z.union([
  z.literal('posix'),
  z.literal('win32'),
  z.object({ kind: z.literal('wsl'), distro: z.string().min(1) })
]);
const ResolveOpts = z
  .object({ remote: z.boolean().optional(), pathContext: PathContextArg.optional() })
  .optional();

const ClaimArgs = z.object({ repoId: RepoId, paneId: PaneId });
const RepoRef = z.object({ repoId: RepoId, root: z.string().min(1), name: z.string().min(1) });
const AnswerArgs = z
  .object({
    id: z.number().int().positive(),
    option: z.number().int().nonnegative().optional(),
    text: z.string().max(10_000).optional()
  })
  .refine((a) => a.option !== undefined || (a.text ?? '').trim() !== '', {
    message: 'An answer needs an option or some text'
  });
const PullArgs = z.object({ repoId: RepoId, jobId: JobId.nullable() });
const ReleaseArgs = z.object({ ids: Ids, error: z.string().max(4_000) });
const HandoffArgs = z.object({ jobId: JobId, lobbyMessageId: z.string().min(1) });
const JobControlArgs = z.object({ jobId: JobId, action: z.enum(['cancel', 'accept']) });
const PermissionAnswerArgs = z.object({ id: JobId, decision: z.enum(['allow', 'deny']) });
const LeftoverArgs = z.object({ resourceId: JobId, action: z.enum(['retry', 'dismiss']) });
/** A client file is a page or two of Markdown; anything far past that is not one. */
const ClientFileWriteArgs = z.object({ layer: Layer, text: z.string().max(200_000) });
const LineText = z.string().trim().min(1).max(1_000);
const LineAt = { index: z.number().int().min(0), was: LineText };
const ClientLineArgs = z.object({
  layer: Layer,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('add'), name: z.string().trim().min(1).max(200), text: LineText }),
    z.object({ kind: z.literal('edit'), ...LineAt, text: LineText }),
    z.object({ kind: z.literal('remove'), ...LineAt })
  ])
});
const RuntimeTestArgs = z.object({ repoId: RepoId, runtime: z.enum(CREW_RUNTIMES) });
const ResultOpenArgs = z.object({ resultId: JobId, file: z.number().int().min(0).max(100) });
const StepKey = z.string().max(80);
const PlanActionArgs = z.discriminatedUnion('action', [
  z.object({
    planVersionId: JobId,
    action: z.literal('approve'),
    baseChoice: z.record(StepKey, z.enum(['default', 'head'])).optional(),
    swaps: z.record(StepKey, z.enum(['continue', 'restart'])).optional(),
    acceptCost: z.boolean().optional()
  }),
  z.object({
    planVersionId: JobId,
    action: z.literal('reject'),
    note: z.string().trim().min(1).max(4_000)
  }),
  z.object({ planVersionId: JobId, action: z.literal('edit'), plan: PlanSchema })
]);
const StepSwapArgs = z.object({
  jobId: JobId,
  stepId: StepKey,
  role: z.string().min(1).max(80),
  runtime: z.enum(CREW_RUNTIMES).nullable(),
  model: z.string().trim().min(1).max(120).nullable()
});

const Paths = z.array(z.string().min(1)).max(200);
const ChooseWorkspaceArgs = z.object({
  path: z.string().min(1),
  leftOut: z.array(z.string().min(1).max(400)).max(50)
});
const CheckOutMemberArgs = z.object({ repo: RepoRef, path: z.string().min(1).max(400) });
const SaveSetupArgs = z.object({
  repo: RepoRef,
  setup: ProjectSetupSchema,
  imports: z.array(z.string().min(1)).max(200),
  updates: z.array(z.string().min(1)).max(200).optional()
});
const SaveSetupFinishArgs = SaveSetupArgs.extend({ finish: z.boolean() });
const MeetAnswerArgs = z.object({
  repo: RepoRef,
  id: z.enum(MEET_QUESTION_IDS),
  answer: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('picks'), picks: z.array(z.number().int().min(0).max(20)).max(20) }),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(MEET_TEXT_MAX) }),
    z.object({
      kind: z.literal('budget'),
      usd: z.number().positive().max(100_000),
      weekPct: z.number().positive().max(100)
    }),
    z.object({ kind: z.literal('skip') })
  ])
});

const ProjectTrustArgs = z.object({
  repoId: RepoId,
  trust: z.object({
    level: z.enum(TRUST_LEVELS),
    autoStartUsd: z.number().positive().max(100_000).nullable()
  })
});

const MeetFinishArgs = z.object({
  repo: RepoRef,
  rules: z
    .array(z.object({ text: z.string().min(1).max(1_000), source: z.string().min(1).max(200) }))
    .max(200)
});

/** Windows already watched, so a second claim from one does not stack listeners. */
const watched = new WeakSet<WebContents>();

export function registerAgencyIpc(service: AgencyService): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_RESOLVE_REPO,
    async (_e, cwd: unknown, opts: unknown): Promise<RepoResolution> =>
      service.resolveRepo(z.string().min(1).parse(cwd), ResolveOpts.parse(opts) ?? {})
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_CLAIM, (e, args: unknown): AdmiralClaimResult => {
    const sender = e.sender;
    // A window that reloads or closes takes its panes with it, so it gives up
    // their claims at the same moment.
    if (!watched.has(sender)) {
      watched.add(sender);
      const releaseAll = (): void => service.releaseOwner(sender.id);
      sender.on('destroyed', releaseAll);
      sender.on('did-navigate', releaseAll);
    }
    return service.claim(ClaimArgs.parse(args), sender.id);
  });

  ipcMain.handle(IPC_CHANNELS.AGENCY_RELEASE, (_e, paneId: unknown) => {
    service.release(PaneId.parse(paneId));
  });

  ipcMain.handle(IPC_CHANNELS.AGENCY_ENSURE_LOBBY, (_e, repo: unknown): string =>
    service.ensureLobby(RepoRef.parse(repo))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_SNAPSHOT,
    (_e, repoId: unknown): AgencySnapshot => service.snapshot(RepoId.parse(repoId))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_ANSWER, (_e, req: unknown): AgencyQuestion | null =>
    service.answer(AnswerArgs.parse(req))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PULL_WAKEUPS,
    async (_e, args: unknown): Promise<WakeupPull> => service.pullWakeups(PullArgs.parse(args))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_ACK_WAKEUPS, (_e, ids: unknown) => {
    service.ackWakeups(Ids.parse(ids));
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_RELEASE_WAKEUPS,
    (_e, args: unknown): WakeupRelease => service.releaseWakeups(ReleaseArgs.parse(args))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_CANCEL_JOBS, (_e, repoId: unknown): number[] =>
    service.cancelJobs(RepoId.parse(repoId))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_MARK_HANDOFF, (_e, args: unknown): boolean =>
    service.markHandoff(HandoffArgs.parse(args))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_CLIENT_ACTIVITY, (_e, jobId: unknown) => {
    service.clientActivity(JobId.parse(jobId));
  });

  ipcMain.handle(IPC_CHANNELS.AGENCY_JOB_DETAIL, (_e, jobId: unknown): AgencyJobDetail | null =>
    service.jobs.detail(JobId.parse(jobId))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PLAN_ACTION,
    async (_e, action: unknown): Promise<PlanActionResult> =>
      service.jobs.decide(PlanActionArgs.parse(action))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_STEP_SWAP,
    async (_e, swap: unknown): Promise<PlanActionResult> =>
      service.jobs.swapStep(StepSwapArgs.parse(swap))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_JOB_CONTROL,
    (_e, control: unknown): JobControlResult => service.closeJob(JobControlArgs.parse(control))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PERMISSION_ANSWER,
    (_e, req: unknown): PermissionAnswerResult =>
      service.answerPermission(PermissionAnswerArgs.parse(req))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_MERGE_PRS,
    async (_e, jobId: unknown): Promise<JobControlResult> => service.mergePrs(JobId.parse(jobId))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_LEFTOVER,
    async (_e, action: unknown): Promise<void> => service.leftover(LeftoverArgs.parse(action))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_RESULTS_REFRESH,
    async (_e, jobId: unknown): Promise<void> => service.prs.refreshPrs(JobId.parse(jobId))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_CREW_HAND_BACK, (_e, crewId: unknown): void => {
    service.crew.flags.handBack(CrewId.parse(crewId));
  });
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CREW_LIST,
    async (_e, repoId: unknown): Promise<CrewCatalog> => service.crewCatalog(RepoId.parse(repoId))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CREW_RUNTIMES,
    async (_e, repoId: unknown): Promise<CrewRuntimeView[]> =>
      service.crewRuntimes(RepoId.parse(repoId))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CREW_RUNTIME_TEST,
    async (_e, args: unknown): Promise<RuntimeTestResult> => {
      const { repoId, runtime } = RuntimeTestArgs.parse(args);
      return service.testCrewRuntime(repoId, runtime);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CREW_SAVE_ROLE,
    async (_e, input: unknown): Promise<RoleSaveResult> =>
      service.saveCrewRole(RoleSaveSchema.parse(input))
  );

  // Opens only a copy in the job's results folder, never a path the renderer names.
  ipcMain.handle(IPC_CHANNELS.AGENCY_RESULT_OPEN, async (_e, open: unknown): Promise<string> => {
    const path = service.results.filePath(ResultOpenArgs.parse(open));
    return path === null ? 'That file is not a delivered result.' : shell.openPath(path);
  });

  ipcMain.handle(IPC_CHANNELS.AGENCY_CLIENT_FILE_WRITE, (_e, args: unknown): void => {
    service.writeClientFile(ClientFileWriteArgs.parse(args));
  });
  ipcMain.handle(IPC_CHANNELS.AGENCY_CLIENT_FILE_KEEP, (_e, layer: unknown): void => {
    service.keepClientFile(Layer.parse(layer));
  });
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CLIENT_FILE_LINE,
    (_e, args: unknown): ClientLineResult => service.changeClientLine(ClientLineArgs.parse(args))
  );

  // Resolves with the saved path, or null when the job cannot be exported or the client cancelled.
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_JOB_EXPORT,
    async (event, jobId: unknown): Promise<string | null> => {
      const out = await service.exportJob(JobId.parse(jobId));
      if (out === null) return null;
      const defaultPath = join(app.getPath('downloads'), out.name);
      const win = BrowserWindow.fromWebContents(event.sender);
      const picked = await (win === null
        ? dialog.showSaveDialog({ defaultPath })
        : dialog.showSaveDialog(win, { defaultPath }));
      if (picked.canceled || picked.filePath === '') return null;
      await writeFile(picked.filePath, out.text, 'utf8');
      return picked.filePath;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PREFLIGHT,
    async (): Promise<AgencyPreflight> => service.preflight()
  );

  registerProjectsIpc(service);
  registerSettingsIpc(service);
}

const SettingsDecideArgs = z.object({ changeId: JobId, approved: z.boolean() });

/** The client's side of the Admiral's settings cards, and "Changed by the Admiral" in Settings. */
function registerSettingsIpc(service: AgencyService): void {
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_SETTINGS_DECIDE,
    async (_e, args: unknown): Promise<boolean> => {
      const { changeId, approved } = SettingsDecideArgs.parse(args);
      return service.settings.decide(changeId, approved);
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_SETTINGS_UNDO,
    async (_e, changeId: unknown): Promise<SettingsUndoOutcome> =>
      service.settings.undo(JobId.parse(changeId))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_SETTINGS_MARKS,
    async (_e, repoId: unknown): Promise<AdmiralSettingMark[]> =>
      service.settings.marks(RepoId.nullable().parse(repoId))
  );
}

/** Onboarding: first run, the project picker, setup, the client file and brief ideas. */
function registerProjectsIpc(service: AgencyService): void {
  const projects = service.projects;
  ipcMain.handle(IPC_CHANNELS.AGENCY_FIRST_RUN_DONE, (): boolean => projects.firstRunDone());
  ipcMain.handle(IPC_CHANNELS.AGENCY_FINISH_FIRST_RUN, () => {
    projects.finishFirstRun();
  });
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PROBE_FOLDERS,
    async (_e, paths: unknown): Promise<ProjectFolder[]> =>
      projects.probeFolders(Paths.parse(paths))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CHOOSE_WORKSPACE,
    async (_e, args: unknown): Promise<AgencyRepoRef> =>
      projects.chooseWorkspace(ChooseWorkspaceArgs.parse(args))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CHECK_OUT_MEMBER,
    async (_e, args: unknown): Promise<void> =>
      projects.checkOutMember(CheckOutMemberArgs.parse(args))
  );
  ipcMain.handle(IPC_CHANNELS.AGENCY_LIST_PROJECTS, (): AgencyProjectSummary[] =>
    projects.listProjects()
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_SCAN_PROJECT,
    async (_e, repo: unknown): Promise<SetupScan> => projects.scan(RepoRef.parse(repo))
  );
  ipcMain.handle(IPC_CHANNELS.AGENCY_SAVE_SETUP, async (_e, args: unknown): Promise<string> => {
    const { finish, ...input } = SaveSetupFinishArgs.parse(args);
    return projects.saveSetup(input, { finish });
  });
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_IMPORT_DIFF,
    async (_e, args: unknown): Promise<ImportDiff> =>
      projects.importDiff(CheckOutMemberArgs.parse(args))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_SHARE_SETUP,
    async (_e, args: unknown): Promise<string[]> => projects.share(SaveSetupArgs.parse(args))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_CLIENT_FILE,
    (_e, layer: unknown): ClientFileView => projects.clientFile(Layer.parse(layer))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_RULE_CANDIDATES,
    async (_e, repo: unknown): Promise<RuleCandidates[]> =>
      projects.ruleCandidates(RepoRef.parse(repo))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PROJECT_TRUST,
    (_e, repoId: unknown): ProjectTrust => projects.trust(RepoId.parse(repoId))
  );
  ipcMain.handle(IPC_CHANNELS.AGENCY_PROJECT_TRUST_SET, (_e, args: unknown): void =>
    projects.setTrust(ProjectTrustArgs.parse(args))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_MEET_ANSWER,
    async (_e, args: unknown): Promise<ClientLineResult> =>
      projects.meetAnswer(MeetAnswerArgs.parse(args))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_MEET_FINISH,
    async (_e, args: unknown): Promise<void> => projects.meetFinish(MeetFinishArgs.parse(args))
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENCY_BRIEF_IDEAS,
    async (_e, repo: unknown): Promise<BriefIdeas> => projects.briefIdeas(RepoRef.parse(repo))
  );
}
