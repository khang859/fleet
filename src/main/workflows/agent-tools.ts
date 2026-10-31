import { join } from 'node:path';
import type { WorkflowEntry, WorkflowNotice } from '../../shared/workflows';
import type { ApprovalStore } from './approval';
import { ToolRefused } from './bridge-routes';
import type { WorkflowCatalog } from './catalog';
import { PROJECT_WORKFLOWS_DIR } from './config';
import { repoRoot, type Exec } from './pr';
import type { WorkflowPosting } from './posting';
import type { PaneIdentity, WorkflowRunManager } from './run-manager';
import type { WorkflowStarts } from './starts';
import { TOOLS, type ToolArgs, type ToolName } from './tools';

export type AgentToolDeps = {
  catalog: WorkflowCatalog;
  approvals: ApprovalStore;
  runs: WorkflowRunManager;
  starts: WorkflowStarts;
  posting: WorkflowPosting;
  exec: Exec;
  paneCwd: (paneId: string) => string | undefined;
  /** The folder of each open pane. */
  openFolders: () => string[];
  notify: (notice: Omit<WorkflowNotice, 'id'>) => void;
};

type InRun = Extract<PaneIdentity, { runId: string }>;

/** What each tool does. The bridge has already checked the pane and the arguments. */
export class WorkflowAgentTools {
  constructor(private readonly deps: AgentToolDeps) {}

  async call(
    paneId: string,
    identity: PaneIdentity,
    tool: ToolName,
    args: unknown
  ): Promise<unknown> {
    switch (tool) {
      case 'fleet_findings_add':
        return this.addFinding(this.inRun(identity), TOOLS[tool].args.parse(args));
      case 'fleet_findings_list':
        return { items: this.deps.runs.listFindings(this.inRun(identity).runId) };
      case 'fleet_findings_merge':
        return this.merge(this.inRun(identity), TOOLS[tool].args.parse(args));
      case 'fleet_run_finish':
        return this.finish(this.inRun(identity), TOOLS[tool].args.parse(args));
      case 'fleet_post_item':
        return this.post(this.inRun(identity), TOOLS[tool].args.parse(args));
      case 'fleet_workflow_list':
        return this.list(paneId, TOOLS[tool].args.parse(args));
      case 'fleet_workflow_run':
        return this.run(paneId, TOOLS[tool].args.parse(args));
      case 'fleet_workflow_status':
        return this.status(TOOLS[tool].args.parse(args));
      case 'fleet_workflow_create':
        return this.create(paneId, TOOLS[tool].args.parse(args));
    }
  }

  private inRun(identity: PaneIdentity): InRun {
    if ('runId' in identity) return identity;
    throw new ToolRefused('refused', 'This pane is not in a run.');
  }

  private addFinding(pane: InRun, args: ToolArgs['fleet_findings_add']): unknown {
    const result = this.deps.runs.addFinding(pane.runId, pane.agentId, args);
    if (result.added) return { added: true, id: result.item.id };
    return { added: false, repeatOf: result.existing };
  }

  private merge(pane: InRun, args: ToolArgs['fleet_findings_merge']): unknown {
    const { ids, ...item } = args;
    return { item: this.deps.runs.mergeFindings(pane.runId, pane.agentId, ids, item) };
  }

  private finish(pane: InRun, args: ToolArgs['fleet_run_finish']): unknown {
    const refused = this.deps.runs.finishAgent(pane.runId, pane.agentId, args.summary);
    if (refused) throw new ToolRefused('refused', refused);
    return { done: true };
  }

  private async post(pane: InRun, args: ToolArgs['fleet_post_item']): Promise<unknown> {
    return this.deps.posting.postItem(pane.runId, args.id);
  }

  private async projectOf(paneId: string, named: string | undefined): Promise<string> {
    if (named) return this.openProject(named);
    const cwd = this.deps.paneCwd(paneId);
    if (!cwd) throw new ToolRefused('no-project', 'Name a project with the project argument.');
    return repoRoot(this.deps.exec, cwd);
  }

  /** A project an agent names must be open in Fleet, so no other folder is in reach. */
  private async openProject(named: string): Promise<string> {
    const { exec, openFolders } = this.deps;
    const root = await repoRoot(exec, named);
    const open = await Promise.all(openFolders().map(async (folder) => repoRoot(exec, folder)));
    if (!open.includes(root)) {
      throw new ToolRefused('no-project', `${named} is not open in Fleet.`);
    }
    return root;
  }

  private async list(paneId: string, args: ToolArgs['fleet_workflow_list']): Promise<unknown> {
    const projectPath = await this.projectOf(paneId, args.project);
    return this.deps.catalog.list(projectPath).map((entry) => ({
      id: entry.id,
      name: entry.def?.name ?? entry.id,
      inputs: entry.def?.inputs ?? [],
      approval: entry.approval,
      error: entry.error
    }));
  }

  private async run(paneId: string, args: ToolArgs['fleet_workflow_run']): Promise<unknown> {
    const projectPath = await this.projectOf(paneId, args.project);
    const { workflow: workflowId, inputs } = args;
    const entry = this.deps.catalog.find(projectPath, workflowId);
    if (!entry) throw new ToolRefused('not-found', `No workflow named ${workflowId}.`);
    this.requireStart(projectPath, entry);

    const started = await this.deps.starts.start(
      { projectPath, workflowId, inputs },
      { origin: 'agent', ruleId: null, focus: false }
    );
    if (!started.ok) throw new ToolRefused(started.code, started.message);
    this.deps.notify({
      kind: 'agent-start',
      text: `An agent started ${entry.def?.name ?? workflowId}.`,
      runId: started.runId,
      projectPath
    });
    return { run: started.runId };
  }

  /** Whether agents may start this file. Any other answer goes to a person. */
  private requireStart(projectPath: string, entry: WorkflowEntry): void {
    const { path, hash, approval, id } = entry;
    if (approval !== 'approved') {
      const text = `An agent tried to start ${id}, which is not approved.`;
      this.deps.notify({ kind: 'info', text, runId: null, projectPath });
      throw new ToolRefused(approval, 'This workflow needs approval from a person first.');
    }
    if (this.deps.approvals.agentsMayStart(path, hash)) return;
    this.deps.notify({
      kind: 'info',
      text: `An agent asks to start ${id}.`,
      runId: null,
      projectPath,
      ask: { path, hash }
    });
    throw new ToolRefused('asked', 'Fleet asked a person. Try again after they answer.');
  }

  private status(args: ToolArgs['fleet_workflow_status']): unknown {
    const run = this.deps.runs.get(args.run);
    if (!run) throw new ToolRefused('not-found', `No run with id ${args.run}.`);
    const agents = run.agents.map(({ role, state, note }) => ({ role, state, note }));
    return { state: run.state, agents, report: run.report };
  }

  private async create(paneId: string, args: ToolArgs['fleet_workflow_create']): Promise<unknown> {
    const projectPath = await this.projectOf(paneId, args.project);
    let id: string;
    try {
      id = this.deps.catalog.createPending(projectPath, 'project', args.id, args.toml);
    } catch (err) {
      throw new ToolRefused('invalid', err instanceof Error ? err.message : String(err));
    }
    this.deps.notify({
      kind: 'agent-create',
      text: `An agent made the workflow ${id}. It waits for your approval.`,
      runId: null,
      projectPath
    });
    return { id, path: join(PROJECT_WORKFLOWS_DIR, `${id}.toml`) };
  }
}
