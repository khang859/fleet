import type { BoardItem, WorkflowProgram, WorkflowRun } from '../../shared/workflows';
import { agentCommandLine } from './agent-command';
import { itemMarker, listCommentBodies, postComment, type Exec } from './pr';
import { postBrief, START_MESSAGE } from './prompts';
import type { RunStore } from './run-store';
import type { WorkflowRunManager } from './run-manager';
import { ToolRefused } from './bridge-routes';

export type PostingDeps = {
  runs: WorkflowRunManager;
  store: RunStore;
  exec: Exec;
  devExtension: string | null;
};

function commentBody(run: WorkflowRun, item: BoardItem): string {
  const place = item.file ? `\`${item.file}${item.line ? `:${item.line}` : ''}\`\n\n` : '';
  return `**${item.kind}** ${place}${item.text}\n\n${itemMarker(run.id, item.id)}`;
}

/**
 * Posts stored findings to a PR. The agent only names ids: main runs `gh` with
 * the stored text on the run's own PR, so text in a finding steers nothing.
 */
export class WorkflowPosting {
  /** The ids a person confirmed, per run. A post tool can post nothing else. */
  private readonly allowed = new Map<string, Set<string>>();

  constructor(private readonly deps: PostingDeps) {}

  private requireRun(runId: string): WorkflowRun {
    const run = this.deps.runs.get(runId);
    if (!run) throw new ToolRefused('not-found', 'This run is gone.');
    return run;
  }

  /** What still needs to go out. An item that was posted never goes again. */
  remaining(run: WorkflowRun): BoardItem[] {
    return run.board.filter((item) => item.mergedInto === undefined && item.post !== 'posted');
  }

  /** After a crash, a `posting` item may have gone out. The PR itself says. */
  private async settleInterrupted(run: WorkflowRun): Promise<void> {
    const interrupted = run.board.filter((item) => item.post === 'posting');
    if (interrupted.length === 0 || !run.pr) return;
    const comments = await listCommentBodies(this.deps.exec, run.projectPath, run.pr.number);
    for (const item of interrupted) {
      const posted = comments.includes(itemMarker(run.id, item.id));
      this.deps.runs.markPost(run.id, item.id, posted ? 'posted' : 'failed');
    }
  }

  /** A person confirmed. Open the pane that posts what is left. */
  async start(runId: string): Promise<number> {
    const run = this.requireRun(runId);
    if (!run.pr) throw new ToolRefused('no-pr', 'This run has no pull request.');
    await this.settleInterrupted(run);
    const ids = this.remaining(run).map((item) => item.id);
    if (ids.length === 0) return 0;
    this.allowed.set(runId, new Set(ids));

    const program: WorkflowProgram = run.agents[0].program;
    const name = `post-${Date.now()}.md`;
    const briefPath = this.deps.store.writePrompt(runId, name, postBrief(program, ids));
    const line = agentCommandLine({
      program,
      mode: 'post',
      briefPath,
      message: START_MESSAGE,
      resume: null,
      devExtension: program === 'pi' ? this.deps.devExtension : null
    });
    await this.deps.runs.openPostPane(runId, line);
    return ids.length;
  }

  /** The post tool. Each item goes once, and a mark on disk proves it. */
  async postItem(runId: string, id: string): Promise<{ posted: string }> {
    const run = this.requireRun(runId);
    if (!run.pr) throw new ToolRefused('no-pr', 'This run has no pull request.');
    if (!this.allowed.get(runId)?.has(id)) {
      throw new ToolRefused('not-allowed', `Item ${id} was not confirmed for posting.`);
    }
    const item = run.board.find((candidate) => candidate.id === id);
    if (!item) throw new ToolRefused('not-found', `No item with id ${id}.`);
    if (item.post === 'posted') return { posted: id };
    if (item.post === 'posting') throw new ToolRefused('posting', `Item ${id} is posting now.`);

    this.deps.runs.markPost(runId, id, 'posting');
    try {
      await postComment(this.deps.exec, run.projectPath, run.pr.number, commentBody(run, item));
    } catch (err) {
      this.deps.runs.markPost(runId, id, 'failed');
      throw new ToolRefused('post-failed', `Item ${id} did not post: ${String(err)}`);
    }
    this.deps.runs.markPost(runId, id, 'posted');
    return { posted: id };
  }
}
