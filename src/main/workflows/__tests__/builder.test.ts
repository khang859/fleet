import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunTab } from '../../../shared/workflows';
import { ApprovalStore } from '../approval';
import { ToolRefused } from '../bridge-routes';
import { builderBrief, WorkflowBuilder, type BuilderDeps } from '../builder';
import { WorkflowCatalog } from '../catalog';
import { toolAllowed } from '../tools';

const FIRST = `name = "My flow"

[[agents]]
role = "Worker"
program = "pi"
prompt = "Do it."
`;

describe('WorkflowBuilder', () => {
  let dir: string;
  let project: string;
  let catalog: WorkflowCatalog;
  let opened: Array<{ paneId: string; cwd: string; line: string }>;
  let tabs: RunTab[];
  let deps: BuilderDeps;
  let builder: WorkflowBuilder;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-builder-'));
    project = join(dir, 'project');
    mkdirSync(project);
    const approvals = new ApprovalStore(join(dir, 'approvals.json'), randomBytes(32));
    catalog = new WorkflowCatalog(approvals, join(dir, 'home'));
    opened = [];
    tabs = [];
    deps = {
      dir: join(dir, 'builders'),
      catalog,
      platform: 'darwin',
      devExtension: null,
      hasProgram: async () => Promise.resolve(true),
      openPane: async (pane) => {
        opened.push(pane);
        return Promise.resolve();
      },
      onTab: (tab) => tabs.push(tab),
      notify: () => undefined,
      onDraftSaved: () => undefined
    };
    builder = new WorkflowBuilder(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function draftPath(id: string): string {
    return join(project, '.fleet', 'workflows', `${id}.toml`);
  }

  it('starts a locked pane with no first message', async () => {
    await builder.start(project, 'claude');

    expect(opened[0].cwd).toBe(project);
    expect(opened[0].line).toContain('--tools');
    expect(opened[0].line).not.toContain('Bash');
    expect(opened[0].line).not.toContain('Start now');
  });

  it('opens a tab for the pane', async () => {
    const started = await builder.start(project, 'pi');

    expect(started.ok).toBe(true);
    expect(tabs[0].paneIds).toEqual([opened[0].paneId]);
    expect(tabs[0].builderId).toBeDefined();
  });

  it('refuses Claude Code on Windows, and says what to use', async () => {
    builder = new WorkflowBuilder({ ...deps, platform: 'win32' });

    const started = await builder.start(project, 'claude');

    expect(started).toEqual({ ok: false, message: expect.stringContaining('Use Pi') });
    expect(opened).toHaveLength(0);
  });

  it('refuses a program that is not installed', async () => {
    builder = new WorkflowBuilder({ ...deps, hasProgram: async () => Promise.resolve(false) });

    expect(await builder.start(project, 'pi')).toEqual({
      ok: false,
      message: 'Pi is not installed.'
    });
  });

  it('tells the agent what the pane is, with the guide', () => {
    const brief = builderBrief('claude');

    expect(brief).toContain('mcp__fleet-bridge__fleet_draft_save');
    expect(brief).toContain('press Review');
    expect(brief).toContain('## Format');
  });

  it('tells Pi to ask in plain text', () => {
    expect(builderBrief('pi')).toContain('Ask in plain text');
  });

  it('makes a draft that waits for approval', async () => {
    await builder.start(project, 'pi');

    const saved = builder.saveDraft(opened[0].paneId, FIRST);

    expect(saved.id).toBe('my-flow');
    expect(readFileSync(draftPath('my-flow'), 'utf8')).toBe(FIRST);
    expect(catalog.find(project, 'my-flow')?.approval).toBe('needs-approval');
  });

  it('replaces only its own draft on the next save', async () => {
    await builder.start(project, 'pi');
    const { paneId } = opened[0];
    builder.saveDraft(paneId, FIRST);
    const next = FIRST.replace('Do it.', 'Do more.');

    expect(builder.saveDraft(paneId, next).id).toBe('my-flow');

    expect(readFileSync(draftPath('my-flow'), 'utf8')).toBe(next);
  });

  it('never replaces a file it did not make', async () => {
    mkdirSync(join(project, '.fleet', 'workflows'), { recursive: true });
    writeFileSync(draftPath('my-flow'), FIRST.replace('Do it.', 'Theirs.'));
    await builder.start(project, 'pi');

    const saved = builder.saveDraft(opened[0].paneId, FIRST);

    expect(saved.id).not.toBe('my-flow');
    expect(readFileSync(draftPath('my-flow'), 'utf8')).toContain('Theirs.');
  });

  it('refuses a bad file, and says why', async () => {
    await builder.start(project, 'pi');

    expect(() => builder.saveDraft(opened[0].paneId, 'name = 1')).toThrow(ToolRefused);
  });

  it('refuses a pane that is not a builder', () => {
    expect(() => builder.saveDraft('other', FIRST)).toThrow('not a builder pane');
  });

  it('does not let a builder pane run, finish, create or write the board', () => {
    for (const tool of [
      'fleet_workflow_run',
      'fleet_workflow_create',
      'fleet_run_finish',
      'fleet_findings_add'
    ] as const) {
      expect(toolAllowed(tool, 'builder')).toBe(false);
    }
  });

  it('identifies its pane only', async () => {
    await builder.start(project, 'pi');

    expect(builder.identify(opened[0].paneId)).toEqual({
      kind: 'builder',
      project,
      draftId: null
    });
    expect(builder.identify('other')).toBeNull();
  });

  it('opens the old talk again, with the same brief', async () => {
    await builder.start(project, 'claude');
    const { paneId } = opened[0];
    builder.onSession(paneId, { id: 'chat-1', transcriptPath: null });
    builder.saveDraft(paneId, FIRST);
    builder.onPaneClosed(paneId);

    await new WorkflowBuilder(deps).reopen(project, 'my-flow');

    expect(opened[1].line).toContain("'chat-1'");
    expect(opened[1].line).toContain('--append-system-prompt-file');
  });

  it('shows the open pane when the draft is open already', async () => {
    await builder.start(project, 'pi');
    builder.saveDraft(opened[0].paneId, FIRST);

    await builder.reopen(project, 'my-flow');

    expect(opened).toHaveLength(1);
    expect(tabs.at(-1)?.focus).toBe(true);
  });

  it('forgets a closed pane', async () => {
    await builder.start(project, 'pi');

    builder.onPaneClosed(opened[0].paneId);

    expect(builder.tabs()).toEqual([]);
    expect(builder.isBuilderPane(opened[0].paneId)).toBe(false);
  });

  it('keeps its files in its own folder', () => {
    expect(existsSync(deps.dir)).toBe(true);
  });
});
