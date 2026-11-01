import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEntries, WorkflowEntry, WorkflowNotice } from '../../../shared/workflows';
import { WorkflowsBridge } from '../bridge-routes';
import { PROJECT_WORKFLOWS_DIR } from '../config';
import { workflowGuide } from '../guide';
import { WorkflowsService } from '../index';
import type { Exec, PrWire } from '../pr';
import type { ToolName } from '../tools';
import { postTo } from './helpers';

const OUTSIDE = 'outside-pane';
const NO_CWD = 'pane-with-no-cwd';
const TOKEN = 'secret';

const TASK = `name = "Task"

[[inputs]]
name = "task"
label = "Task"

[[agents]]
role = "Worker"
program = "pi"
prompt = "{{task}}"
`;

const CHANGED = TASK.replace('Worker', 'Other worker');

const BROKEN = 'name = "Broken"\n';

const PR_FLOW = `name = "PR flow"

[[inputs]]
name = "pr"
label = "Pull request"
type = "pr"

[[agents]]
role = "Reader"
program = "pi"
prompt = "Read it."
`;

const CLOSED_PR: PrWire = {
  number: 7,
  title: 'A change',
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'closed',
  merged_at: null,
  author_association: 'MEMBER',
  user: { login: 'someone', type: 'User' },
  head: { sha: 'abc', repo: { full_name: 'acme/app' } },
  base: { repo: { full_name: 'acme/app' } }
};

type Reply = { ok: boolean; code?: string; data?: unknown };

type World = {
  service: WorkflowsService;
  bridge: WorkflowsBridge;
  project: string;
  /** The folders of open panes. */
  folders: string[];
  opened: string[];
  pushes: WorkflowEntries[];
  catalogPath: (id: string) => string;
};

let dir: string;
let world: World;

function makeWorld(): World {
  const project = join(dir, 'project');
  const folders = [project];
  mkdirSync(project);
  const opened: string[] = [];
  const bridge = new WorkflowsBridge();
  const pushes: WorkflowEntries[] = [];

  const exec: Exec = async (command, args) => {
    if (command === 'git') return Promise.resolve(`${project}\n`);
    return Promise.resolve(args[0] === 'repo' ? 'acme/app\n' : JSON.stringify(CLOSED_PR));
  };

  const service = new WorkflowsService({
    home: join(dir, 'home'),
    platform: 'darwin',
    now: () => Date.now(),
    vault: {
      isEncryptionAvailable: () => false,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: (enc) => enc.toString()
    },
    power: {
      blocker: { start: () => 1, stop: () => undefined },
      monitor: { on: () => undefined, isOnBatteryPower: () => false }
    },
    bridge,
    onEntries: (reply) => pushes.push(reply),
    openPane: async (pane) => {
      opened.push(pane.paneId);
      return Promise.resolve();
    },
    killPane: () => undefined,
    paneCwd: (paneId) => (paneId === NO_CWD ? undefined : project),
    openFolders: () => folders,
    tokenOf: () => TOKEN,
    lastOutputAt: () => 0,
    sendPrompt: async () => Promise.resolve(true),
    addPermissionAnswerer: () => () => undefined,
    answerPermission: () => true,
    subscribeSessions: () => undefined,
    bridgeProblem: () => null,
    hasProgram: async () => Promise.resolve(true),
    devExtension: null,
    onState: () => undefined,
    onTab: () => undefined,
    exec
  });
  bridge.connect(service);

  const catalogPath = (id: string): string => join(project, PROJECT_WORKFLOWS_DIR, `${id}.toml`);
  return { service, bridge, project, opened, catalogPath, folders, pushes };
}

/** Calls a tool over the bridge, as an agent does. */
async function call(tool: ToolName, args: unknown, pane = OUTSIDE): Promise<Reply> {
  const body = { paneId: pane, token: TOKEN, args };
  const answer = await postTo(world.bridge, `/workflows/${tool}`, body);
  return answer.body as Reply;
}

async function runTask(pane = OUTSIDE): Promise<Reply> {
  return call('fleet_workflow_run', { workflow: 'task', inputs: { task: 'Do it.' } }, pane);
}

/** A person saved it in Fleet's editor. Agents start it with no question. */
function saveInEditor(text = TASK, fileName = 'task'): void {
  const { project: projectPath, service } = world;
  const req = { projectPath, scope: 'project', fileName, text, baseHash: null } as const;
  service.catalog.save(req);
}

/** A file an agent or a teammate put in the project. Nobody approved it yet. */
function dropFile(text = TASK, id = 'task'): void {
  mkdirSync(join(world.project, PROJECT_WORKFLOWS_DIR), { recursive: true });
  writeFileSync(world.catalogPath(id), text);
}

function entryOf(id = 'task'): WorkflowEntry {
  const entry = world.service.catalog.find(world.project, id);
  if (!entry) throw new Error(`No workflow ${id}.`);
  return entry;
}

/** A person approved the file on the page, so it runs but agents must ask. */
function approveByHand(id = 'task'): void {
  world.service.catalog.approve(world.project, id, entryOf(id).hash);
}

function notices(): WorkflowNotice[] {
  return world.service.state().notices;
}

function askNotice(): WorkflowNotice {
  const notice = notices().find((candidate) => candidate.ask);
  if (!notice) throw new Error('No ask notice.');
  return notice;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-tools-'));
  world = makeWorld();
});

afterEach(() => {
  world.service.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('fleet_workflow_list', () => {
  it('lists each file with its inputs and approval', async () => {
    saveInEditor();
    dropFile(PR_FLOW, 'pr-flow');

    const reply = await call('fleet_workflow_list', {});

    expect(reply).toMatchObject({
      ok: true,
      data: [
        {
          id: 'pr-flow',
          name: 'PR flow',
          inputs: [{ name: 'pr', label: 'Pull request', type: 'pr', required: true }],
          approval: 'needs-approval'
        },
        {
          id: 'task',
          name: 'Task',
          inputs: [{ name: 'task', label: 'Task', type: 'text', required: true }],
          approval: 'approved'
        }
      ]
    });
  });

  it('shows a broken file by its id, with the error', async () => {
    dropFile(BROKEN, 'broken');

    const reply = await call('fleet_workflow_list', {});
    const [entry] = reply.data as Array<{ name: string; inputs: unknown[]; error: string }>;

    expect(entry.name).toBe('broken');
    expect(entry.inputs).toEqual([]);
    expect(entry.error).toEqual(expect.any(String));
  });

  it('shows a changed file as changed', async () => {
    saveInEditor();
    dropFile(CHANGED);

    const reply = await call('fleet_workflow_list', {});

    expect(reply.data).toMatchObject([{ id: 'task', approval: 'changed' }]);
  });

  it('gives an empty list for a project with no workflows', async () => {
    expect(await call('fleet_workflow_list', {})).toEqual({ ok: true, data: [] });
  });

  it('refuses a pane with no project', async () => {
    const reply = await call('fleet_workflow_list', {}, NO_CWD);

    expect(reply).toMatchObject({ ok: false, code: 'no-project' });
  });

  it('refuses a named project that is not open in Fleet', async () => {
    world.folders.length = 0;

    const reply = await call('fleet_workflow_list', { project: world.project }, NO_CWD);

    expect(reply).toMatchObject({ ok: false, code: 'no-project' });
  });

  it('takes the project argument for a pane with no project', async () => {
    saveInEditor();

    const args = { project: world.project };
    const reply = await call('fleet_workflow_list', args, NO_CWD);

    expect(reply.data).toMatchObject([{ id: 'task' }]);
  });
});

describe('fleet_workflow_run', () => {
  it('starts an approved workflow', async () => {
    saveInEditor();

    const reply = await runTask();

    expect(reply.ok).toBe(true);
    const { run: runId } = reply.data as { run: string };
    const run = world.service.runs.get(runId);
    expect(run?.origin).toBe('agent');
    expect(run?.inputs).toEqual({ task: 'Do it.' });
  });

  it('opens the panes in the background', async () => {
    saveInEditor();

    const reply = await runTask();
    await vi.waitFor(() => expect(world.opened).toHaveLength(1));

    const { run: runId } = reply.data as { run: string };
    expect(world.service.listTabs()[0]).toMatchObject({ runId, focus: false });
  });

  it('tells the person that an agent started it', async () => {
    saveInEditor();

    const reply = await runTask();
    const { run: runId } = reply.data as { run: string };

    expect(notices()).toMatchObject([
      { kind: 'agent-start', text: 'An agent started Task.', runId, projectPath: world.project }
    ]);
  });

  it('refuses a file that needs approval, with a notice', async () => {
    dropFile();

    const reply = await runTask();

    expect(reply).toMatchObject({ ok: false, code: 'needs-approval' });
    expect(world.service.runs.list()).toEqual([]);
    expect(notices()).toMatchObject([
      {
        kind: 'info',
        text: 'An agent tried to start task, which is not approved.',
        runId: null,
        projectPath: world.project
      }
    ]);
    expect(askNotice).toThrow();
  });

  it('refuses a file that changed after approval, with a notice', async () => {
    saveInEditor();
    dropFile(CHANGED);

    const reply = await runTask();

    expect(reply).toMatchObject({ ok: false, code: 'changed' });
    expect(world.service.runs.list()).toEqual([]);
    expect(notices()).toMatchObject([{ kind: 'info', runId: null }]);
    expect(askNotice).toThrow();
  });

  it('refuses a name it does not know, with no notice', async () => {
    const reply = await call('fleet_workflow_run', { workflow: 'nope' });

    expect(reply).toMatchObject({ ok: false, code: 'not-found' });
    expect(notices()).toEqual([]);
  });

  it('passes on the refusal of a start, with no start notice', async () => {
    saveInEditor();

    const reply = await call('fleet_workflow_run', { workflow: 'task' });

    expect(reply).toMatchObject({ ok: false, code: 'missing-input' });
    expect(world.service.runs.list()).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it('refuses a closed PR, as an agent has no way to allow one', async () => {
    saveInEditor(PR_FLOW, 'pr-flow');

    const args = { workflow: 'pr-flow', inputs: { pr: '7' } };
    const reply = await call('fleet_workflow_run', args);

    expect(reply).toMatchObject({ ok: false, code: 'pr-closed' });
  });

  it('refuses a second run for one target', async () => {
    saveInEditor();
    await runTask();

    expect(await runTask()).toMatchObject({ ok: false, code: 'duplicate' });
    expect(world.service.runs.list()).toHaveLength(1);
  });

  it('refuses an agent inside a run', async () => {
    saveInEditor();
    await runTask();
    await vi.waitFor(() => expect(world.opened).toHaveLength(1));
    const before = notices().length;

    const args = { workflow: 'task', inputs: { task: 'Another.' } };
    const reply = await call('fleet_workflow_run', args, world.opened[0]);

    expect(reply).toMatchObject({ ok: false, code: 'refused' });
    expect(world.service.runs.list()).toHaveLength(1);
    expect(notices()).toHaveLength(before);
  });
});

describe('the ask flow', () => {
  beforeEach(() => {
    dropFile();
    approveByHand();
  });

  it('asks a person and starts nothing', async () => {
    const reply = await runTask();

    expect(reply).toMatchObject({ ok: false, code: 'asked' });
    expect(world.service.runs.list()).toEqual([]);

    const { path, hash } = entryOf();
    expect(askNotice()).toMatchObject({
      kind: 'info',
      text: 'An agent asks to start task.',
      runId: null,
      projectPath: world.project,
      ask: { path, hash }
    });
  });

  it('starts after Allow, and takes the question away', async () => {
    await runTask();

    world.service.answerAsk(askNotice().id, true);

    expect(askNotice).toThrow();
    expect((await runTask()).ok).toBe(true);
  });

  it('does not ask again after Allow', async () => {
    await runTask();
    world.service.answerAsk(askNotice().id, true);

    await runTask();

    expect(askNotice).toThrow();
  });

  it('asks again after Deny, and takes the first question away', async () => {
    await runTask();

    world.service.answerAsk(askNotice().id, false);

    expect(notices()).toEqual([]);
    expect(await runTask()).toMatchObject({ ok: false, code: 'asked' });
    expect(world.service.runs.list()).toEqual([]);
  });

  it('ends Allow when the file changes', async () => {
    await runTask();
    world.service.answerAsk(askNotice().id, true);

    dropFile(CHANGED);

    expect(await runTask()).toMatchObject({ ok: false, code: 'changed' });

    approveByHand();

    expect(await runTask()).toMatchObject({ ok: false, code: 'asked' });
  });

  it('gives no Allow to a file that changed while the question waited', async () => {
    await runTask();
    const question = askNotice();

    dropFile(CHANGED);
    approveByHand();
    world.service.answerAsk(question.id, true);

    expect(await runTask()).toMatchObject({ ok: false, code: 'asked' });
  });

  it('does nothing for a question that is gone', async () => {
    await runTask();

    world.service.answerAsk('gone', true);

    expect(await runTask()).toMatchObject({ ok: false, code: 'asked' });
  });
});

describe('fleet_workflow_guide', () => {
  it('tells an agent how to write a workflow', async () => {
    const reply = await call('fleet_workflow_guide', {});

    expect(reply).toEqual({ ok: true, data: { guide: workflowGuide() } });
  });
});

describe('the live list', () => {
  const lastPush = (): string[] | undefined =>
    world.pushes.at(-1)?.entries.map((entry) => `${entry.id}:${entry.approval}`);

  it('sends the list when a person approves a file', () => {
    dropFile();
    world.service.list(world.project);

    approveByHand();

    expect(world.pushes.at(-1)?.projectPath).toBe(world.project);
    expect(lastPush()).toEqual(['task:approved']);
  });

  it('sends the list when a file changes on disk', async () => {
    dropFile();
    world.service.list(world.project);

    // A new watcher needs a moment to start, so write until it hears. Each write
    // restarts the wait of 100 ms, so the writes must be further apart than that.
    await vi.waitFor(
      () => {
        dropFile(CHANGED, 'other');
        expect(lastPush()).toContain('other:needs-approval');
      },
      { timeout: 3000, interval: 300 }
    );
  });

  it('removes the create notice when a person approves the file', async () => {
    await call('fleet_workflow_create', { id: 'task', toml: TASK });
    expect(notices()).toHaveLength(1);

    world.service.approve(world.project, 'task', entryOf().hash);

    expect(notices()).toEqual([]);
  });
});

describe('fleet_workflow_create', () => {
  it('writes the file and gives its id and path', async () => {
    const reply = await call('fleet_workflow_create', { id: 'new-flow', toml: TASK });

    expect(reply).toEqual({
      ok: true,
      data: { id: 'new-flow', path: join(PROJECT_WORKFLOWS_DIR, 'new-flow.toml') }
    });
    expect(readFileSync(world.catalogPath('new-flow'), 'utf8')).toBe(TASK);
  });

  it('leaves the new file waiting for approval', async () => {
    await call('fleet_workflow_create', { id: 'task', toml: TASK });

    expect(entryOf().approval).toBe('needs-approval');
    expect(await runTask()).toMatchObject({ ok: false, code: 'needs-approval' });
  });

  it('tells the person about the new file', async () => {
    await call('fleet_workflow_create', { id: 'new-flow', toml: TASK });

    expect(notices()).toMatchObject([
      {
        kind: 'agent-create',
        text: 'An agent made the workflow new-flow. It waits for your approval.',
        runId: null,
        projectPath: world.project
      }
    ]);
  });

  it('never replaces a file', async () => {
    dropFile();

    const reply = await call('fleet_workflow_create', { id: 'task', toml: CHANGED });

    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    expect(readFileSync(world.catalogPath('task'), 'utf8')).toBe(TASK);
    expect(notices()).toEqual([]);
  });

  it('never replaces an approved file or ends its approval', async () => {
    saveInEditor();

    await call('fleet_workflow_create', { id: 'task', toml: CHANGED });

    expect(entryOf().approval).toBe('approved');
  });

  it('refuses a bad file and writes nothing', async () => {
    const reply = await call('fleet_workflow_create', { id: 'bad', toml: BROKEN });

    expect(reply).toMatchObject({ ok: false, code: 'invalid' });
    expect(existsSync(world.catalogPath('bad'))).toBe(false);
    expect(notices()).toEqual([]);
  });

  it('keeps a name with a path in the workflows folder', async () => {
    const reply = await call('fleet_workflow_create', { id: '../../evil', toml: TASK });

    expect(reply.data).toMatchObject({ id: 'evil' });
    expect(existsSync(world.catalogPath('evil'))).toBe(true);
  });

  it('refuses an agent inside a run', async () => {
    saveInEditor();
    await runTask();
    await vi.waitFor(() => expect(world.opened).toHaveLength(1));

    const args = { id: 'new-flow', toml: TASK };
    const reply = await call('fleet_workflow_create', args, world.opened[0]);

    expect(reply).toMatchObject({ ok: false, code: 'refused' });
    expect(existsSync(world.catalogPath('new-flow'))).toBe(false);
  });
});
