import type { PrRef, RunReport } from '../../shared/workflows';
import { listCommentBodies, postComment, reportMarker, type Exec } from './pr';
import type { WorkflowRunManager } from './run-manager';

export type PostingDeps = {
  runs: WorkflowRunManager;
  exec: Exec;
};

type Postable = { projectPath: string; pr: PrRef; report: RunReport };

/**
 * Posts a run's final report to its PR as one comment, so the PR gets the same
 * text a person read. Main runs `gh` with the stored text: no agent takes part.
 */
export class WorkflowPosting {
  private readonly busy = new Set<string>();

  constructor(private readonly deps: PostingDeps) {}

  private postable(runId: string): Postable {
    const run = this.deps.runs.get(runId);
    if (!run) throw new Error('This run is gone.');
    const { projectPath, pr, report } = run;
    if (!pr) throw new Error('This run has no pull request.');
    if (!report) throw new Error('This run has no report.');
    if (report.incomplete) throw new Error('This report is incomplete.');
    return { projectPath, pr, report };
  }

  /** A person confirmed. The mark on the PR stops a second comment after a lost answer. */
  async post(runId: string): Promise<void> {
    const { projectPath, pr, report } = this.postable(runId);
    if (report.posted || this.busy.has(runId)) return;

    this.busy.add(runId);
    try {
      const marker = reportMarker(runId);
      const comments = await listCommentBodies(this.deps.exec, projectPath, pr.number);
      if (!comments.includes(marker)) {
        await postComment(this.deps.exec, projectPath, pr.number, `${report.text}\n\n${marker}`);
      }
      this.deps.runs.updateReport(runId, { posted: true });
    } finally {
      this.busy.delete(runId);
    }
  }
}
