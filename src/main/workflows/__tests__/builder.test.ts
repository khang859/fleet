import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunTab } from '../../../shared/workflows';
import { ApprovalStore, DisabledFiles } from '../approval';
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
  let killed: string[];
  let tabs: RunTab[];
  let deps: BuilderDeps;
  let builder: WorkflowBuilder;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-builder-'));
    project = join(dir, 'project');
    mkdirSync(project);
    const approvals = new ApprovalStore(join(dir, 'approvals.json'), randomBytes(32));
    catalog = new WorkflowCatalog(
      approvals,
      new DisabledFiles(join(dir, 'disabled.json'), randomBytes(32)),
      join(dir, 'home')
    );
    opened = [];
    killed = [];
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
      killPane: (paneId) => killed.push(paneId),
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

  it('starts a research pane with no edit tools and no first message', async () => {
    await builder.start(project, 'claude');

    expect(opened[0].cwd).toBe(project);
    expect(opened[0].line).toContain(`'--disallowedTools' 'Edit' 'Write' 'NotebookEdit'`);
    expect(opened[0].line).not.toContain('--strict-mcp-config');
    expect(opened[0].line).not.toContain('Start now');
  });

  it('lets a Pi builder research, with no edit tools', async () => {
    await builder.start(project, 'pi');

    expect(opened[0].line).toContain(`'--exclude-tools' 'edit,write'`);
    expect(opened[0].line).not.toContain('mcp__');
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
    expect(brief).toContain('mcp__fleet-bridge__fleet_draft_read');
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

  it('keeps a change that a person made to the draft', async () => {
    await builder.start(project, 'pi');
    const { paneId } = opened[0];
    builder.saveDraft(paneId, FIRST);
    const theirs = FIRST.replace('Do it.', 'Theirs.');
    writeFileSync(draftPath('my-flow'), theirs);

    expect(() => builder.saveDraft(paneId, FIRST)).toThrow('Read it again with fleet_draft_read');

    expect(readFileSync(draftPath('my-flow'), 'utf8')).toBe(theirs);
  });

  it('makes no new file when a person removed the draft', async () => {
    await builder.start(project, 'pi');
    const { paneId } = opened[0];
    builder.saveDraft(paneId, FIRST);
    rmSync(draftPath('my-flow'));

    expect(() => builder.saveDraft(paneId, FIRST)).toThrow('A person removed this draft');

    expect(existsSync(draftPath('my-flow'))).toBe(false);
  });

  it('reads the draft as a person left it, and may then save over it', async () => {
    await builder.start(project, 'pi');
    const { paneId } = opened[0];
    builder.saveDraft(paneId, FIRST);
    const theirs = FIRST.replace('Do it.', 'Theirs.');
    writeFileSync(draftPath('my-flow'), theirs);
    const next = FIRST.replace('Do it.', 'Both.');

    expect(builder.readDraft(paneId)).toEqual({ id: 'my-flow', toml: theirs });
    builder.saveDraft(paneId, next);

    expect(readFileSync(draftPath('my-flow'), 'utf8')).toBe(next);
  });

  it('keeps a change through a reopen until the agent reads it', async () => {
    await builder.start(project, 'pi');
    const { paneId } = opened[0];
    builder.saveDraft(paneId, FIRST);
    builder.onPaneClosed(paneId);
    const theirs = FIRST.replace('Do it.', 'Theirs.');
    writeFileSync(draftPath('my-flow'), theirs);

    await builder.reopen(project, 'my-flow', 'project');

    expect(() => builder.saveDraft(opened[1].paneId, FIRST)).toThrow('fleet_draft_read');
    expect(readFileSync(draftPath('my-flow'), 'utf8')).toBe(theirs);
  });

  it('says when there is no draft to read', async () => {
    await builder.start(project, 'pi');
    const { paneId } = opened[0];

    expect(builder.readDraft(paneId)).toMatchObject({ id: null, toml: null });

    builder.saveDraft(paneId, FIRST);
    rmSync(draftPath('my-flow'));

    expect(builder.readDraft(paneId)).toMatchObject({ id: 'my-flow', toml: null });
    expect(() => builder.saveDraft(paneId, FIRST)).toThrow('A person removed this draft');
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

    await new WorkflowBuilder(deps).reopen(project, 'my-flow', 'project');

    expect(opened[1].line).toContain("'chat-1'");
    expect(opened[1].line).toContain('--append-system-prompt-file');
  });

  it('starts with the chosen model and effort, and keeps them after a restart', async () => {
    await builder.start(project, 'claude', { model: 'opus', effort: 'max' });
    const { paneId } = opened[0];
    builder.onSession(paneId, { id: 'chat-1', transcriptPath: null });
    builder.saveDraft(paneId, FIRST);
    builder.onPaneClosed(paneId);

    await new WorkflowBuilder(deps).reopen(project, 'my-flow', 'project');

    expect(opened[0].line).toContain(`'--model' 'opus' '--effort' 'max'`);
    expect(opened[1].line).toContain(`'--model' 'opus' '--effort' 'max'`);
  });

  it('refuses a level the program does not take', async () => {
    expect(await builder.start(project, 'claude', { effort: 'off' })).toEqual({
      ok: false,
      message: 'effort must be one of low, medium, high, xhigh, max.'
    });
    expect(opened).toEqual([]);
  });

  it('shows the open pane when the draft is open already', async () => {
    await builder.start(project, 'pi');
    builder.saveDraft(opened[0].paneId, FIRST);

    await builder.reopen(project, 'my-flow', 'project');

    expect(opened).toHaveLength(1);
    expect(tabs.at(-1)?.focus).toBe(true);
  });

  it('ends the agent when a person closes its tab', async () => {
    const { id } = (await builder.start(project, 'claude')) as { id: string };

    builder.close(id);

    expect(killed).toEqual([opened[0].paneId]);
  });

  it('goes on with the talk in a new pane after its tab closed', async () => {
    const { id } = (await builder.start(project, 'claude')) as { id: string };
    const { paneId } = opened[0];
    builder.onSession(paneId, { id: 'chat-1', transcriptPath: null });
    builder.saveDraft(paneId, FIRST);
    builder.close(id);
    builder.onPaneClosed(paneId);

    await builder.reopen(project, 'my-flow', 'project');

    expect(opened).toHaveLength(2);
    expect(opened[1].line).toContain("'--resume' 'chat-1'");
  });

  it('kills nothing for a builder with no open pane', async () => {
    const { id } = (await builder.start(project, 'claude')) as { id: string };
    builder.onPaneClosed(opened[0].paneId);

    builder.close(id);
    builder.close('unknown');

    expect(killed).toEqual([]);
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
