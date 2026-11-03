import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  BuilderInfo,
  BuilderStart,
  RunTab,
  WorkflowNotice,
  WorkflowProgram,
  WorkflowScope
} from '../../shared/workflows';
import { modelChoiceProblem, type ModelChoice } from '../../shared/workflow-models';
import { writeAtomicSync } from '../fs-atomic';
import { agentCommandLine } from './agent-command';
import { ToolRefused } from './bridge-routes';
import type { WorkflowCatalog } from './catalog';
import { hashText, parseWorkflow, slugify } from './config';
import { workflowGuide } from './guide';
import { toolNameFor } from './tools';

const NEW_DRAFT_LABEL = 'New workflow';

/** A session a person can open again. A bad file only loses the way back to the talk. */
const SAVED = z.object({
  id: z.string(),
  project: z.string(),
  program: z.enum(['pi', 'claude']),
  draftId: z.string().nullable(),
  /** Where the draft is now. A person can move it. Sessions from before this field were project. */
  draftScope: z.enum(['project', 'personal']).default('project'),
  /** The hash of this builder's last save, to see if a person changed the file. */
  draftHash: z.string().nullable(),
  sessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  /** A session from an older Fleet has neither: the program defaults. Checked at start. */
  model: z.string().optional(),
  effort: z.string().optional()
});

type Saved = z.infer<typeof SAVED>;

export type BuilderDeps = {
  /** Fleet's folder for builder sessions and their briefs. */
  dir: string;
  catalog: WorkflowCatalog;
  platform: NodeJS.Platform;
  devExtension: string | null;
  hasProgram: (program: WorkflowProgram) => Promise<boolean>;
  openPane: (pane: { paneId: string; cwd: string; line: string }) => Promise<void>;
  killPane: (paneId: string) => void;
  onTab: (tab: RunTab) => void;
  notify: (notice: Omit<WorkflowNotice, 'id'>) => void;
  /** A draft changed, so a draft pane on show must read it again. */
  onDraftSaved: (project: string) => void;
};

/** The agent's whole job. Fleet writes it, so the person need not explain the pane. */
export function builderBrief(program: WorkflowProgram): string {
  const save = toolNameFor(program, 'fleet_draft_save');
  const read = toolNameFor(program, 'fleet_draft_read');
  const list = toolNameFor(program, 'fleet_workflow_list');
  const ask =
    program === 'claude'
      ? 'Use AskUserQuestion for questions with choices.'
      : 'You have no question tool. Ask in plain text, then end your turn.';
  return `You are in a Fleet workflow builder pane. Your only job is to make one Fleet workflow with the person here.

# Rules

- This pane makes workflows. Do not change code or files here, and you cannot start a run. If the person asks for other work, say that this pane only makes workflows.
- You can read the project, to learn how its work is done.
- You can research: search the web, read pages, use your MCP tools and run read-only shell commands. Use them when the person asks, or to learn the best way to do a step.
- Ask what the workflow must do, then which steps run in order and which run at the same time. ${ask}
- Ask which program each agent uses, if the person did not say.
- Use ${list} to see the workflows this project has.
- Before you change a draft, read it with ${read}. A person can change it in the editor, so start from what it says now.
- Save the draft with ${save}. Send the whole file each time. The person sees each save beside this pane.
- A bad file is refused, and the reply says why. Fix it and save again.
- A save is refused when a person changed the draft after you read it. Follow the reply, and do not make a second file.
- When the draft is ready, tell the person to press Review in the draft panel. A person must approve the file before it can run. You cannot approve it.
- Use ${save}, and not fleet_workflow_create. This pane can save only with ${save}.

${workflowGuide()}`;
}

/** Builder panes: real program panes with one job, and one draft each. */
export class WorkflowBuilder {
  private readonly sessions = new Map<string, Saved>();
  /** Pane id to session id, while the pane is open. */
  private readonly panes = new Map<string, string>();

  constructor(private readonly deps: BuilderDeps) {
    mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
    for (const session of this.load()) this.sessions.set(session.id, session);
  }

  private get file(): string {
    return join(this.deps.dir, 'sessions.json');
  }

  private load(): Saved[] {
    try {
      return z.array(SAVED).parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return [];
    }
  }

  private persist(): void {
    writeAtomicSync(this.file, JSON.stringify([...this.sessions.values()], null, 2));
  }

  /** A new builder, or a refusal that a person can read. */
  async start(
    project: string,
    program: WorkflowProgram,
    choice: ModelChoice = {}
  ): Promise<BuilderStart> {
    const problem = modelChoiceProblem(program, choice) ?? (await this.programProblem(program));
    if (problem) return { ok: false, message: problem };
    const session: Saved = {
      id: randomUUID(),
      project,
      program,
      model: choice.model,
      effort: choice.effort,
      draftId: null,
      draftScope: 'project',
      draftHash: null,
      sessionId: null,
      transcriptPath: null
    };
    this.sessions.set(session.id, session);
    this.persist();
    return this.open(session, null);
  }

  private async programProblem(program: WorkflowProgram): Promise<string | null> {
    if (program === 'claude' && this.deps.platform === 'win32') {
      return 'Claude Code has no Fleet tools on Windows. Use Pi, or the editor.';
    }
    const ok = await this.deps.hasProgram(program);
    return ok ? null : `${program === 'pi' ? 'Pi' : 'Claude Code'} is not installed.`;
  }

  /** Go back to the agent that made a draft: its old talk, with the same brief. */
  async reopen(project: string, draftId: string, scope: WorkflowScope): Promise<BuilderStart> {
    const session = this.sessionFor(project, draftId, scope);
    if (!session) return { ok: false, message: 'No builder session made this draft.' };
    const open = this.paneOf(session.id);
    if (open) {
      this.emitTab(session, open, true);
      return { ok: true, id: session.id };
    }
    const handle = session.program === 'pi' ? session.transcriptPath : session.sessionId;
    return this.open(session, handle);
  }

  private sessionFor(project: string, draftId: string, scope: WorkflowScope): Saved | undefined {
    return [...this.sessions.values()].find(
      (candidate) =>
        candidate.project === project &&
        candidate.draftId === draftId &&
        candidate.draftScope === scope
    );
  }

  /** A person moved a draft, so its builder goes on saving it where it is now. */
  onMoved(project: string, draftId: string, from: WorkflowScope, to: WorkflowScope): void {
    const session = this.sessionFor(project, draftId, from);
    if (!session) return;
    session.draftScope = to;
    this.persist();
  }

  private paneOf(id: string): string | null {
    for (const [paneId, sessionId] of this.panes) {
      if (sessionId === id) return paneId;
    }
    return null;
  }

  private briefPath(session: Saved): string {
    const path = join(this.deps.dir, `${session.id}.md`);
    writeFileSync(path, builderBrief(session.program), { mode: 0o600 });
    return path;
  }

  private async open(session: Saved, resume: string | null): Promise<BuilderStart> {
    const paneId = randomUUID();
    const line = agentCommandLine({
      program: session.program,
      mode: 'research',
      briefPath: this.briefPath(session),
      message: null,
      resume,
      devExtension: session.program === 'pi' ? this.deps.devExtension : null,
      talks: true,
      model: session.model,
      effort: session.effort
    });
    this.panes.set(paneId, session.id);
    try {
      await this.deps.openPane({ paneId, cwd: session.project, line });
    } catch (err) {
      this.panes.delete(paneId);
      return { ok: false, message: `The pane did not open: ${String(err)}` };
    }
    this.emitTab(session, paneId, true);
    return { ok: true, id: session.id };
  }

  private emitTab(session: Saved, paneId: string | null, focus: boolean): void {
    this.deps.onTab({
      runId: `builder-${session.id}`,
      label: session.draftId ?? NEW_DRAFT_LABEL,
      cwd: session.project,
      projectPath: session.project,
      paneIds: paneId ? [paneId] : [],
      focus,
      builderId: session.id
    });
  }

  isBuilderPane(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  /** What a pane may do, or null for a pane that is not a builder. */
  identify(paneId: string): { kind: 'builder'; project: string; draftId: string | null } | null {
    const session = this.sessionOf(paneId);
    if (!session) return null;
    return { kind: 'builder', project: session.project, draftId: session.draftId };
  }

  private sessionOf(paneId: string): Saved | undefined {
    const id = this.panes.get(paneId);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  onSession(paneId: string, chat: { id: string; transcriptPath: string | null }): void {
    const session = this.sessionOf(paneId);
    if (!session) return;
    session.sessionId = chat.id;
    session.transcriptPath = chat.transcriptPath;
    this.persist();
  }

  /**
   * A person closed the builder's tab. The agent has no other way back to the
   * screen, so it ends, and a reopen goes on with its talk in a new pane.
   */
  close(id: string): void {
    const paneId = this.paneOf(id);
    if (paneId) this.deps.killPane(paneId);
  }

  onPaneClosed(paneId: string): void {
    const session = this.sessionOf(paneId);
    if (!session) return;
    this.panes.delete(paneId);
    this.emitTab(session, null, false);
  }

  /**
   * The draft as it is now. The agent has read a person's change, so its next
   * save may replace that file. A removed draft stays removed.
   */
  readDraft(paneId: string): { id: string | null; toml: string | null; note?: string } {
    const session = this.sessionOf(paneId);
    if (!session) throw new ToolRefused('refused', 'This pane is not a builder pane.');
    const { project, draftId, draftScope } = session;
    if (!draftId) return { id: null, toml: null, note: 'No draft yet. Your first save makes it.' };
    const entry = this.deps.catalog.find(project, draftId, draftScope);
    if (!entry) {
      return {
        id: draftId,
        toml: null,
        note: 'A person removed this draft. Do not save it again.'
      };
    }
    const toml = this.deps.catalog.readText(entry.path);
    session.draftHash = hashText(toml);
    this.persist();
    return { id: draftId, toml };
  }

  /** The first save names the file, and a later save replaces only this pane's draft. */
  saveDraft(paneId: string, toml: string): { id: string; approval: string } {
    const session = this.sessionOf(paneId);
    if (!session) throw new ToolRefused('refused', 'This pane is not a builder pane.');
    try {
      this.writeDraft(session, paneId, toml);
    } catch (err) {
      throw new ToolRefused('invalid', err instanceof Error ? err.message : String(err));
    }
    session.draftHash = hashText(toml);
    this.persist();
    this.deps.onDraftSaved(session.project);
    return { id: session.draftId ?? '', approval: 'A person must approve this draft.' };
  }

  private writeDraft(session: Saved, paneId: string, toml: string): void {
    const { project, draftId, draftScope, draftHash } = session;
    if (draftId) this.deps.catalog.replaceDraft(project, draftScope, draftId, toml, draftHash);
    else this.createDraft(session, paneId, toml);
  }

  private createDraft(session: Saved, paneId: string, toml: string): void {
    const { catalog } = this.deps;
    const free = this.freeId(session.project, slugify(parseWorkflow(toml).name));
    session.draftId = catalog.createPending(session.project, 'project', free, toml);
    this.persist();
    this.emitTab(session, paneId, false);
    this.deps.notify({
      kind: 'agent-create',
      text: `An agent made the workflow ${session.draftId}. It waits for your approval.`,
      runId: null,
      projectPath: session.project,
      workflowId: session.draftId,
      workflowScope: 'project'
    });
  }

  /** A name that no file has, so a first save never meets a file it did not make. */
  private freeId(project: string, wanted: string): string {
    const taken = new Set(this.deps.catalog.list(project).map((entry) => entry.id));
    if (!taken.has(wanted)) return wanted;
    let number = 2;
    while (taken.has(`${wanted}-${number}`)) number += 1;
    return `${wanted}-${number}`;
  }

  info(id: string): BuilderInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const { project, program, draftId, draftScope } = session;
    return { id, projectPath: project, program, draftId, draftScope };
  }

  /** The paths of the drafts a person can go back to the agent that made. */
  draftsWithSession(project: string): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.project === project)
      .flatMap(({ draftId, draftScope }) => {
        const entry = draftId ? this.deps.catalog.find(project, draftId, draftScope) : undefined;
        return entry ? [entry.path] : [];
      });
  }

  tabs(): RunTab[] {
    const open = [...this.panes.entries()].flatMap(([paneId, id]) => {
      const session = this.sessions.get(id);
      return session ? [{ paneId, session }] : [];
    });
    return open.map(({ paneId, session }) => ({
      runId: `builder-${session.id}`,
      label: session.draftId ?? NEW_DRAFT_LABEL,
      cwd: session.project,
      projectPath: session.project,
      paneIds: [paneId],
      focus: false,
      builderId: session.id
    }));
  }
}
