import { create } from 'zustand';
import type {
  RunTab,
  WorkflowEntries,
  WorkflowEntry,
  WorkflowProject,
  WorkflowRun,
  WorkflowsState
} from '../../../shared/workflows';
import { ACTIVE_RUN_STATES } from '../../../shared/workflows';
import { clearCreatedPty, markPtyCreated } from '../hooks/use-terminal';
import { useToastStore } from './toast-store';
import { hasRunTab, useWorkspaceStore } from './workspace-store';

export type WorkflowsView = 'workflows' | 'runs' | 'automatic';

type WorkflowsStore = {
  state: WorkflowsState;
  projects: WorkflowProject[];
  projectPath: string | null;
  entries: WorkflowEntry[];
  view: WorkflowsView;
  /** The run shown in full, in place of the Runs list. */
  openRunId: string | null;
  /** The agent whose plan fills the run page. */
  planAgentId: string | null;
  connect: () => () => void;
  setView: (view: WorkflowsView) => void;
  openRun: (runId: string | null) => void;
  openPlan: (agentId: string | null) => void;
  loadProjects: (paths: string[]) => Promise<void>;
  setProject: (path: string) => Promise<void>;
  addProject: () => Promise<void>;
  refresh: () => Promise<void>;
};

const EMPTY: WorkflowsState = {
  runs: [],
  rules: [],
  away: [],
  notices: [],
  limits: { maxAgents: 12, runOnBattery: false }
};

/** Call main. Each method is typed by `WorkflowsApi`. */
export const callWorkflows = window.fleet.workflows.call;

/** What a failed call to main says, with Electron's wrapper taken off. */
export function workflowErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

/** A call failed, and a person must hear of it. */
export function showWorkflowError(err: unknown): void {
  useToastStore.getState().show(workflowErrorText(err));
}

/** Every pane this window has shown. A run that names only these has no new work to show. */
const seenPanes = new Set<string>();

export function showWorkflowsPage(): void {
  const ws = useWorkspaceStore.getState();
  const page = ws.workspace.tabs.find((tab) => tab.type === 'workflows');
  if (page) ws.setActiveTab(page.id);
}

export function showRun(runId: string): void {
  showWorkflowsPage();
  const store = useWorkflowsStore.getState();
  const run = store.state.runs.find((candidate) => candidate.id === runId);
  if (run) store.setProject(run.projectPath).catch(showWorkflowError);
  store.openRun(runId);
}

/** The page of one agent's plan. */
export function showPlan(runId: string, agentId: string): void {
  showRun(runId);
  useWorkflowsStore.getState().openPlan(agentId);
}

function isShowingRun(runId: string): boolean {
  const { workspace, activeTabId } = useWorkspaceStore.getState();
  return workspace.tabs.find((tab) => tab.id === activeTabId)?.workflowRunId === runId;
}

function applyRunTab(tab: RunTab): void {
  const hasTab = hasRunTab(useWorkspaceStore.getState(), tab.runId);
  const isNew = tab.paneIds.some((paneId) => !seenPanes.has(paneId));
  // A person closed this tab. Its panes are going away one at a time.
  if (!hasTab && !isNew) return;

  for (const paneId of tab.paneIds) {
    seenPanes.add(paneId);
    markPtyCreated(paneId);
  }
  const wasShowing = isShowingRun(tab.runId);
  useWorkspaceStore.getState().syncRunTab(tab, tab.focus);
  // The last pane closed under a person who was looking, so they get the report.
  if (wasShowing && tab.paneIds.length === 0 && !tab.builderId) showRun(tab.runId);
}

function dropClosedPanes(previous: WorkflowRun[], next: WorkflowRun[]): void {
  const open = new Set(
    next.flatMap((run) => [...run.agents.map((agent) => agent.paneId), ...run.keptPanes])
  );
  for (const run of previous) {
    for (const agent of run.agents) {
      if (agent.paneId && !open.has(agent.paneId)) clearCreatedPty(agent.paneId);
    }
  }
}

export function isRunActive(run: WorkflowRun): boolean {
  return ACTIVE_RUN_STATES.includes(run.state);
}

export const useWorkflowsStore = create<WorkflowsStore>((set, get) => ({
  state: EMPTY,
  projects: [],
  projectPath: null,
  entries: [],
  view: 'workflows',
  openRunId: null,
  planAgentId: null,

  connect: () => {
    const applyState = (state: WorkflowsState): void => {
      dropClosedPanes(get().state.runs, state.runs);
      set({ state });
    };
    const applyEntries = ({ projectPath, entries }: WorkflowEntries): void => {
      if (projectPath === get().projectPath) set({ entries });
    };
    // A folder that cannot be watched, such as one on a network, still updates here.
    const onFocus = (): void => void get().refresh().catch(showWorkflowError);

    const stopState = window.fleet.workflows.onState(applyState);
    const stopEntries = window.fleet.workflows.onEntries(applyEntries);
    const stopTab = window.fleet.workflows.onTab(applyRunTab);
    window.addEventListener('focus', onFocus);
    callWorkflows('state').then(applyState).catch(showWorkflowError);
    callWorkflows('tabs')
      .then((tabs) => tabs.forEach(applyRunTab))
      .catch(showWorkflowError);
    return () => {
      stopState();
      stopEntries();
      stopTab();
      window.removeEventListener('focus', onFocus);
    };
  },

  setView: (view) => set({ view, openRunId: null, planAgentId: null }),

  openRun: (openRunId) => set({ openRunId, view: 'runs', planAgentId: null }),

  openPlan: (planAgentId) => set({ planAgentId }),

  loadProjects: async (paths) => {
    // The project on show stays listed. A person can add one that has no open pane.
    const current = get().projectPath;
    const projects = await callWorkflows('projects', current ? [...paths, current] : paths);
    set({ projects });
    if (!get().projectPath && projects[0]) await get().setProject(projects[0].path);
  },

  setProject: async (projectPath) => {
    const entries = projectPath === get().projectPath ? get().entries : [];
    set({ projectPath, entries, openRunId: null, planAgentId: null });
    await get().refresh();
  },

  addProject: async () => {
    const path = await callWorkflows('pickProject');
    if (!path) return;
    const known = get().projects.map((project) => project.path);
    const projects = await callWorkflows('projects', [...known, path]);
    set({ projects });
    const added = projects.find((project) => !known.includes(project.path));
    await get().setProject(added?.path ?? path);
  },

  refresh: async () => {
    const { projectPath } = get();
    if (!projectPath) return;
    const entries = await callWorkflows('list', projectPath);
    // A slow reply must not fill the list of a project that a person left.
    if (projectPath === get().projectPath) set({ entries });
  }
}));
