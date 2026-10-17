import { ipcMain, type WebContents } from 'electron';
import { z } from 'zod';
import type {
  AdmiralClaimResult,
  AgencyPreflight,
  AgencyQuestion,
  AgencySnapshot,
  RepoResolution,
  WakeupPull,
  WakeupRelease
} from '../../shared/agency';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { AgencyService } from './index';

/**
 * The renderer's way into the agency. Every argument is parsed here, in main,
 * before it reaches the store: a value that arrived over IPC is untrusted
 * input, and these write the durable record of what the client decided.
 */

const RepoId = z.string().regex(/^[0-9a-f]{16}$/);
const PaneId = z.string().min(1);
const JobId = z.number().int().positive();
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
    (_e, args: unknown): WakeupPull => service.pullWakeups(PullArgs.parse(args))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_ACK_WAKEUPS, (_e, ids: unknown) => {
    service.ackWakeups(Ids.parse(ids));
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_RELEASE_WAKEUPS,
    (_e, args: unknown): WakeupRelease => service.releaseWakeups(ReleaseArgs.parse(args))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_RETRY_NOW, (_e, repoId: unknown) => {
    service.retryNow(RepoId.parse(repoId));
  });

  ipcMain.handle(IPC_CHANNELS.AGENCY_CANCEL_JOBS, (_e, repoId: unknown): number[] =>
    service.cancelJobs(RepoId.parse(repoId))
  );

  ipcMain.handle(IPC_CHANNELS.AGENCY_MARK_HANDOFF, (_e, args: unknown): boolean =>
    service.markHandoff(HandoffArgs.parse(args))
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENCY_PREFLIGHT,
    async (): Promise<AgencyPreflight> => service.preflight()
  );
}
