import type { BrowserWindow, IpcMain, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { WorkflowsApi, WorkflowScope } from '../../shared/workflows';
import { DEFAULT_DAILY_LIMIT } from './scheduler';
import type { WorkflowsService } from './index';

export type Dialogs = {
  open: (options: OpenDialogOptions) => Promise<string | null>;
  save: (options: SaveDialogOptions) => Promise<string | null>;
};

/** Electron's dialogs, on the window when there is one. */
export function electronDialogs(
  dialog: Electron.Dialog,
  getWindow: () => BrowserWindow | null
): Dialogs {
  return {
    async open(options) {
      const window = getWindow();
      const picked = await (window
        ? dialog.showOpenDialog(window, options)
        : dialog.showOpenDialog(options));
      return picked.filePaths[0] ?? null;
    },
    async save(options) {
      const window = getWindow();
      const picked = await (window
        ? dialog.showSaveDialog(window, options)
        : dialog.showSaveDialog(options));
      return picked.filePath || null;
    }
  };
}

/** Each thing the page can ask for. Nothing outside this list is reachable. */
function apiOf(service: WorkflowsService, dialogs: Dialogs): WorkflowsApi {
  const { catalog, runs, scheduler } = service;

  const importToml = async (projectPath: string, scope: WorkflowScope): Promise<string | null> => {
    const source = await dialogs.open({
      filters: [{ name: 'Workflow', extensions: ['toml'] }],
      properties: ['openFile']
    });
    return source && service.importFile(projectPath, scope, source);
  };

  const pickReportPath: WorkflowsApi['pickReportPath'] = async (runId) => {
    const path = await dialogs.save({
      defaultPath: service.reportPath(runId)?.split('/').at(-1) ?? 'report.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    // The system dialog asked about a file that exists, so this replaces it.
    return path ? service.saveReportAt(runId, path, true) : null;
  };

  return {
    state: () => service.state(),
    tabs: () => service.listTabs(),
    projects: async (paths) => service.projects(paths),
    pickProject: async () => dialogs.open({ properties: ['openDirectory'] }),
    list: (projectPath) => catalog.list(projectPath),
    readText: (path) => catalog.readText(path),
    starters: () => service.starters(),
    save: (req) => catalog.save(req),
    remove: (projectPath, id) => service.remove(projectPath, id),
    approve: (projectPath, id, hash) => service.approve(projectPath, id, hash),
    importToml,
    preview: async (req) => service.preview(req),
    start: async (req) => service.startManual(req),
    stop: (runId) => runs.stop(runId),
    close: (runId, removeWorktree) => runs.close(runId, removeWorktree),
    retry: async (runId, agentId) => runs.retry(runId, agentId),
    skip: (runId, agentId) => runs.skip(runId, agentId),
    keepWaiting: (runId, agentId) => runs.keepWaiting(runId, agentId),
    addTime: (runId) => runs.addTime(runId),
    goOn: async (runId) => runs.goOn(runId),
    openAgent: async (runId, agentId) => runs.openAgent(runId, agentId),
    retryPrepare: (runId) => runs.retryPrepare(runId),
    answerPermission: (toolUseId, decision) => service.answerPermission(toolUseId, decision),
    reportPath: (runId) => service.reportPath(runId),
    saveReport: (runId, path, replace) => service.saveReport(runId, path, replace),
    pickReportPath,
    post: async (runId) => service.post(runId),
    remainingPosts: (runId) => service.remainingPosts(runId),
    dismissNotice: (id) => service.dismissNotice(id),
    answerAsk: (id, allow) => service.answerAsk(id, allow),
    saveRule: (rule) =>
      scheduler.saveRule({ ...rule, dailyLimit: rule.dailyLimit || DEFAULT_DAILY_LIMIT }),
    deleteRule: (id) => scheduler.deleteRule(id),
    setRuleEnabled: (id, enabled) => scheduler.setEnabled(id, enabled),
    runRule: async (id) => {
      const outcome = await scheduler.runNow(id);
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
    setLimits: (limits) => scheduler.setLimits(limits),
    clearAway: () => scheduler.clearAway()
  };
}

export function registerWorkflowsIpc(
  ipc: IpcMain,
  service: WorkflowsService,
  dialogs: Dialogs
): void {
  // The preload types each call against WorkflowsApi, so this table stays untyped.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const api = apiOf(service, dialogs) as Record<string, (...args: unknown[]) => unknown>;
  ipc.handle(IPC_CHANNELS.WORKFLOWS_CALL, (_event, method: string, args: unknown[]) => {
    if (!Object.hasOwn(api, method)) throw new Error(`No workflow call named ${method}.`);
    return api[method](...args);
  });
}
