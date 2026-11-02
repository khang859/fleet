import { postTarget, type PostTarget, type RunReport } from '../../shared/workflows';
import { listCommentBodies, postComment, reportMarker, type Exec } from './pr';
import type { WorkflowRunManager } from './run-manager';

export type PostingDeps = {
  runs: WorkflowRunManager;
  exec: Exec;
};

type Postable = { projectPath: string; target: PostTarget; report: RunReport };

/**
 * Posts a run's final report to its PR or issue as one comment, so GitHub gets
 * the same text a person read. Main runs `gh` with the stored text: no agent
 * takes part.
 */
export class WorkflowPosting {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: PostingDeps) {}

  private postable(runId: string): Postable {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error('This run is gone.');
    const { projectPath, report } = run;
    const target = postTarget(run);
    if (!target) throw new Error('This run has no pull request or issue.');
    if (!report) throw new Error('This run has no report.');
    if (report.incomplete) throw new Error('This report is incomplete.');
    return { projectPath, target, report };
  }

  /** A person confirmed. The mark on GitHub stops a second comment after a lost answer. */
  async post(runId: string): Promise<void> {
    const { projectPath, target, report } = this.postable(runId);
    if (report.posted || this.busy.has(runId)) return;

    this.busy.add(runId);
    try {
      const marker = reportMarker(runId);
      const comments = await listCommentBodies(this.deps.exec, projectPath, target.number);
      if (!comments.includes(marker)) {
        await postComment(this.deps.exec, projectPath, target, `${report.text}\n\n${marker}`);
      }
      this.deps.runs.updateReport(runId, { posted: true });
    } finally {
      this.busy.delete(runId);
    }
  }
}
