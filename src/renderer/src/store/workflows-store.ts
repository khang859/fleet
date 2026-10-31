import { create } from 'zustand';
import type {
  RunTab,
  WorkflowEntry,
  WorkflowProject,
  WorkflowRun,
  WorkflowsState
} from '../../../shared/workflows';
import { ACTIVE_RUN_STATES } from '../../../shared/workflows';
import { clearCreatedPty, markPtyCreated } from '../hooks/use-terminal';
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
  connect: () => () => void;
  setView: (view: WorkflowsView) => void;
  openRun: (runId: string | null) => void;
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
  if (run) void store.setProject(run.projectPath);
  store.openRun(runId);
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
  if (wasShowing && tab.paneIds.length === 0) showRun(tab.runId);
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

  connect: () => {
    const applyState = (state: WorkflowsState): void => {
      dropClosedPanes(get().state.runs, state.runs);
      set({ state });
    };
    const stopState = window.fleet.workflows.onState(applyState);
    const stopTab = window.fleet.workflows.onTab(applyRunTab);
    void callWorkflows('state').then(applyState);
    void callWorkflows('tabs').then((tabs) => tabs.forEach(applyRunTab));
    return () => {
      stopState();
      stopTab();
    };
  },

  setView: (view) => set({ view, openRunId: null }),

  openRun: (openRunId) => set({ openRunId, view: 'runs' }),

  loadProjects: async (paths) => {
    const projects = await callWorkflows('projects', paths);
    set({ projects });
    const current = get().projectPath;
    const keep = projects.some((project) => project.path === current);
    if (!keep && projects[0]) await get().setProject(projects[0].path);
  },

  setProject: async (projectPath) => {
    set({ projectPath, openRunId: null });
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
    set({ entries: await callWorkflows('list', projectPath) });
  }
}));
