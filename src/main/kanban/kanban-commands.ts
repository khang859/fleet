import type { KanbanStore } from './kanban-store';
import type { KanbanDispatcher } from './kanban-dispatcher';
import { CodedError } from '../errors';
import type {
  CreateTaskInput,
  TaskStatus,
  TaskDetail,
  BoardCard,
  Board,
  Task,
  TaskComment,
  TaskEvent,
  UpdateTaskFields,
  WorkspaceKind,
  PendingMode,
  TaskAttachment,
  TaskArtifact,
  ArtifactListItem,
  ArtifactListFilter,
  ScheduleInput,
  SwarmInput,
  SwarmCreated,
  Feature,
  FeatureStatus,
  CreateFeatureInput,
  UpdateFeatureInput,
  FeatureDetail,
  ConflictState,
  WorktreeInfo,
  PruneResult,
  Project
} from '../../shared/kanban-types';
import { createSwarm as buildSwarm } from './kanban-swarm';
import { validateSchedule, computeNextRun } from './schedule';
import { createLogger } from '../logger';
import {
  removeWorktree,
  mergeWorktreeToBase,
  pushAndCreatePr,
  checkMergeConflicts,
  createFeaturePr,
  updateIntegrationBranchFromMain,
  worktreeStatus,
  isBranchMerged
} from './workspace';
import { dirname } from 'path';
import { statSync } from 'fs';
import type { KanbanReviewActionResult, KanbanPruneWorktreeResult } from '../../shared/ipc-api';
import { removeAttachmentFile } from './attachments';
import { deriveBoardSlug } from './board-slug';

const log = createLogger('kanban-commands');

/** Statuses a human may set manually (everything except dispatcher-owned `running`). */
export const MANUAL_STATUSES: TaskStatus[] = [
  'triage',
  'todo',
  'ready',
  'blocked',
  'review',
  'done',
  'archived'
];

export interface CreateDefaults {
  workspaceKind: WorkspaceKind;
  maxRuntimeSeconds: number | null;
}

/** Upper bound on workers per swarm — keeps one swarm from monopolizing the global dispatcher. */
export const SWARM_MAX_WORKERS = 20;

/**
 * KanbanCommands is the single application layer over KanbanStore/KanbanDispatcher.
 * The board IPC, the CLI socket server, and any future front door all call these
 * methods, so validation and event-logging cannot drift between them.
 */
export class KanbanCommands {
  constructor(
    private store: KanbanStore,
    private dispatcher: KanbanDispatcher,
    private getCreateDefaults: () => CreateDefaults,
    private getProfiles: () => Array<{ name: string; role: string }> = () => []
  ) {}

  create(input: CreateTaskInput): Task {
    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree tasks require a source repo (repoPath)', 'BAD_REQUEST');
    }
    if (workspaceKind === 'dir' && !input.workspacePath) {
      throw new CodedError('dir tasks require a workspace path (workspacePath)', 'BAD_REQUEST');
    }
    const task = this.store.createTask({
      ...input,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    });
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }

  createSwarm(input: SwarmInput): SwarmCreated {
    const goal = (input.goal ?? '').trim();
    if (goal === '') throw new CodedError('swarm requires a goal', 'BAD_REQUEST');
    const workers = input.workers ?? [];
    if (workers.length < 1) {
      throw new CodedError('swarm requires at least one worker', 'BAD_REQUEST');
    }
    if (workers.length > SWARM_MAX_WORKERS) {
      throw new CodedError(`swarm supports at most ${SWARM_MAX_WORKERS} workers`, 'BAD_REQUEST');
    }
    if (!(input.verifierAssignee ?? '').trim()) {
      throw new CodedError('swarm requires a verifier', 'BAD_REQUEST');
    }
    if (!(input.synthesizerAssignee ?? '').trim()) {
      throw new CodedError('swarm requires a synthesizer', 'BAD_REQUEST');
    }

    const d = this.getCreateDefaults();
    const workspaceKind = input.workspaceKind ?? d.workspaceKind;
    if (workspaceKind === 'worktree' && !input.repoPath) {
      throw new CodedError('worktree swarms require a source repo (repoPath)', 'BAD_REQUEST');
    }
    if (workspaceKind === 'dir' && !input.workspacePath) {
      throw new CodedError('dir swarms require a workspace path (workspacePath)', 'BAD_REQUEST');
    }

    const profiles = this.getProfiles();
    const workerProfiles = new Set(profiles.filter((p) => p.role === 'worker').map((p) => p.name));
    for (const w of workers) {
      if (!(w.profile ?? '').trim())
        throw new CodedError('each worker requires a profile', 'BAD_REQUEST');
      if (!(w.title ?? '').trim())
        throw new CodedError('each worker requires a title', 'BAD_REQUEST');
      if (workerProfiles.size > 0 && !workerProfiles.has(w.profile)) {
        throw new CodedError(`unknown worker profile: ${w.profile}`, 'BAD_REQUEST');
      }
    }

    if (input.seedArtifactId) {
      const art = this.store.getArtifact(input.seedArtifactId);
      if (!art) throw new CodedError(`artifact not found: ${input.seedArtifactId}`, 'NOT_FOUND');
      if (art.state !== 'kept') {
        throw new CodedError('only kept artifacts can be reused', 'BAD_REQUEST');
      }
    }

    const resolved: SwarmInput = {
      ...input,
      goal,
      workspaceKind,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? d.maxRuntimeSeconds
    };

    // The seeded artifact copy attaches to the root task inside the same transaction; if any
    // step throws, the copied attachment file is removed so a rollback leaves no orphan.
    const copiedFiles: string[] = [];
    let created: SwarmCreated;
    try {
      created = this.store.transaction(() => {
        const c = buildSwarm(this.store, resolved);
        if (resolved.seedArtifactId) {
          const att = this.store.attachArtifactToTask(c.rootId, resolved.seedArtifactId);
          copiedFiles.push(att.storedPath);
        }
        return c;
      });
    } catch (err) {
      for (const p of copiedFiles) removeAttachmentFile(p);
      throw err;
    }

    // Emit after commit so IPC/notifier never fire mid-transaction.
    this.store.appendEvent(created.rootId, null, 'swarm_created', {
      goal,
      workerCount: workers.length
    });
    for (const id of [...created.workerIds, created.verifierId, created.synthesizerId]) {
      const t = this.store.getTask(id);
      this.store.appendEvent(id, null, 'task_created', { title: t?.title ?? '' });
    }
    return created;
  }

  list(filter: { status?: TaskStatus; boardSlug?: string } = {}): BoardCard[] {
    const board = this.store.listBoard(filter.boardSlug);
    return filter.status ? board.filter((c) => c.status === filter.status) : board;
  }

  listBoards(): Board[] {
    return this.store.listBoards();
  }

  createBoard(name: string): Board {
    if (name.trim() === '' || deriveBoardSlug(name) === '') {
      throw new CodedError('invalid board name', 'BAD_REQUEST');
    }
    return this.store.createBoard(name);
  }

  renameBoard(slug: string, name: string): void {
    if (name.trim() === '' || deriveBoardSlug(name) === '') {
      throw new CodedError('invalid board name', 'BAD_REQUEST');
    }
    this.store.renameBoard(slug, name);
  }

  deleteBoard(slug: string): void {
    if (slug === 'default') {
      throw new CodedError('the default board cannot be deleted', 'BAD_REQUEST');
    }
    if (this.store.listBoard(slug).some((c) => c.status === 'running')) {
      throw new CodedError('stop running tasks before deleting this board', 'BAD_REQUEST');
    }
    this.store.deleteBoard(slug);
  }

  show(id: string): TaskDetail | null {
    const task = this.store.getTask(id);
    if (!task) return null;
    return {
      task,
      comments: this.store.listComments(id),
      runs: this.store.listRuns(id),
      events: this.store.listEvents(id),
      parents: this.store
        .parentsOf(id)
        .map((pid) => this.store.getTask(pid))
        .filter((t): t is Task => t !== null),
      children: this.store
        .childrenOf(id)
        .map((cid) => this.store.getTask(cid))
        .filter((t): t is Task => t !== null),
      attachments: this.store.listAttachments(id),
      artifacts: this.store.listArtifacts(id)
    };
  }

  private requireTask(id: string): Task {
    const t = this.store.getTask(id);
    if (!t) throw new CodedError(`task not found: ${id}`, 'NOT_FOUND');
    return t;
  }

  update(id: string, fields: UpdateTaskFields): void {
    this.requireTask(id);
    this.store.updateTask(id, fields);
    this.store.appendEvent(id, null, 'task_updated', { fields });
  }

  assign(id: string, profile: string | null): void {
    this.update(id, { assignee: profile });
  }

  setManualStatus(id: string, status: TaskStatus): void {
    const task = this.requireTask(id);
    if (task.status === 'running' || status === 'running') {
      throw new CodedError('cannot manually change a running task', 'BAD_REQUEST');
    }
    if (!MANUAL_STATUSES.includes(status)) {
      throw new CodedError(`invalid status: ${status}`, 'BAD_REQUEST');
    }
    // Review is a worktree-only lane: its drawer actions (merge/PR) assume a
    // committed branch, so scratch/dir tasks have no business there.
    if (status === 'review' && task.workspaceKind !== 'worktree') {
      throw new CodedError('only worktree tasks can enter review', 'BAD_REQUEST');
    }
    this.store.setStatus(id, status);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: status,
      by: 'user'
    });
    if (task.status === 'scheduled' && status !== 'scheduled') {
      // leaving the scheduled lane unschedules the task (drag or action button)
      this.store.dropSchedule(id);
    }
    // Archiving a worktree task tears down its worktree + branch (best-effort;
    // removeWorktree never throws, but guard archival defensively regardless).
    if (
      status === 'archived' &&
      task.workspaceKind === 'worktree' &&
      task.workspacePath &&
      task.repoPath
    ) {
      try {
        const { branchKept } = removeWorktree({
          repoPath: task.repoPath,
          workspacePath: task.workspacePath,
          branchName: task.branchName,
          baseBranch: task.baseBranch
        });
        // Unmerged work is preserved (branch kept) rather than `git branch -D`'d;
        // surface it so the user knows a dangling branch is theirs to recover.
        if (branchKept && task.branchName) {
          this.store.appendEvent(id, null, 'unmerged_branch_kept', { branch: task.branchName });
        }
      } catch (err) {
        log.warn('worktree removal on archive failed', {
          taskId: id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    // Scratch safety net (§6): never warn-then-delete. If unregistered files remain in the
    // ephemeral workspace, preserve it and surface a warning; only delete when nothing is at risk.
    if (status === 'archived' && task.workspaceKind === 'scratch' && task.workspacePath) {
      const leftovers = this.store.scratchLeftovers(id);
      if (leftovers.length > 0) {
        this.store.appendEvent(id, null, 'artifacts_unregistered', { files: leftovers });
      } else {
        this.store.deleteScratchWorkspace(id);
      }
    }
  }

  ready(id: string): void {
    this.setManualStatus(id, 'ready');
  }

  unblock(id: string): void {
    this.setManualStatus(id, 'ready');
  }

  archive(id: string): void {
    this.setManualStatus(id, 'archived');
  }

  block(id: string, reason: string): void {
    const task = this.requireTask(id);
    if (task.status === 'running') {
      throw new CodedError('cannot block a running task', 'BAD_REQUEST');
    }
    this.store.blockTask(id, reason);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: 'blocked',
      by: 'user',
      reason
    });
  }

  complete(id: string, result: string): void {
    const task = this.requireTask(id);
    if (task.status === 'running') {
      throw new CodedError('cannot complete a running task', 'BAD_REQUEST');
    }
    this.store.completeTask(id, result);
    this.store.appendEvent(id, null, 'status_changed', {
      from: task.status,
      to: 'done',
      by: 'user',
      result
    });
  }

  comment(id: string, body: string): TaskComment {
    this.requireTask(id);
    const comment = this.store.addComment(id, 'human', body);
    this.store.appendEvent(id, null, 'comment_added', { author: 'human' });
    return comment;
  }

  /**
   * Answer a blocked card and re-queue it in one step. Posts the reply (when
   * non-empty) as a human comment, clears the failure counters, then resumes in
   * the same mode the card last ran: a worker run returns to `ready`, an
   * orchestrator run (`decompose`/`specify`) is re-armed back to `triage`. The
   * dispatcher is ticked immediately so the agent picks up without waiting for
   * the next poll.
   */
  replyAndResume(id: string, body: string): void {
    const task = this.requireTask(id);
    if (task.status !== 'blocked') {
      throw new CodedError('only blocked tasks can be resumed', 'BAD_REQUEST');
    }
    const text = body.trim();
    if (text !== '') this.comment(id, text);
    this.store.clearFailures(id);
    // `current_run_id` is nulled on block, so the last run's mode is the signal
    // for how to resume; listRuns is deterministically ordered newest-first.
    const lastMode = this.store.listRuns(id)[0]?.mode ?? 'work';
    if (lastMode === 'decompose' || lastMode === 'specify') {
      this.store.setStatusCleared(id, 'triage');
      this.store.appendEvent(id, null, 'status_changed', {
        from: 'blocked',
        to: 'triage',
        by: 'user'
      });
      // status is now 'triage', so requestOrchestration's guard passes.
      this.requestOrchestration(id, lastMode);
    } else {
      this.unblock(id);
    }
    this.dispatcher.tick();
  }

  addAttachment(taskId: string, sourcePath: string): TaskAttachment {
    this.requireTask(taskId);
    const att = this.store.addAttachment(taskId, sourcePath);
    this.store.appendEvent(taskId, null, 'attachment_added', {
      id: att.id,
      filename: att.filename
    });
    return att;
  }

  removeAttachment(id: string): void {
    const att = this.store.getAttachment(id);
    if (!att) return;
    this.store.removeAttachment(id);
    this.store.appendEvent(att.taskId, null, 'attachment_removed', {
      id,
      filename: att.filename
    });
  }

  getAttachment(id: string): TaskAttachment | null {
    return this.store.getAttachment(id);
  }

  // ---- Artifacts (durable task outputs) ----

  listArtifacts(taskId: string): TaskArtifact[] {
    this.requireTask(taskId);
    return this.store.listArtifacts(taskId);
  }

  listAllArtifacts(filter: ArtifactListFilter = {}): ArtifactListItem[] {
    return this.store.listAllArtifacts(filter);
  }

  getArtifact(id: string): TaskArtifact | null {
    return this.store.getArtifact(id);
  }

  discardArtifact(id: string): void {
    const art = this.store.getArtifact(id);
    if (art?.state !== 'kept') return;
    this.store.discardArtifact(id);
    this.store.appendEvent(art.taskId, art.runId, 'artifact_discarded', {
      id,
      filename: art.filename
    });
  }

  restoreArtifact(id: string): void {
    const art = this.store.getArtifact(id);
    if (art?.state !== 'discarded') return;
    this.store.restoreArtifact(id);
    this.store.appendEvent(art.taskId, art.runId, 'artifact_restored', {
      id,
      filename: art.filename
    });
  }

  /** Hard delete (row + file). The drawer Discard is soft; this is the explicit Remove action. */
  removeArtifact(id: string): void {
    const art = this.store.getArtifact(id);
    if (!art) return;
    this.store.purgeArtifact(id);
    this.store.appendEvent(art.taskId, art.runId, 'artifact_removed', {
      id,
      filename: art.filename
    });
  }

  /** Reuse a kept artifact as input to an existing task (copy into its attachments). */
  reuseArtifact(artifactId: string, targetTaskId: string): TaskAttachment {
    this.requireTask(targetTaskId);
    const art = this.store.getArtifact(artifactId);
    if (!art) throw new CodedError(`artifact not found: ${artifactId}`, 'NOT_FOUND');
    if (art.state !== 'kept')
      throw new CodedError('only kept artifacts can be reused', 'BAD_REQUEST');
    const att = this.store.attachArtifactToTask(targetTaskId, artifactId);
    this.store.appendEvent(targetTaskId, null, 'attachment_added', {
      id: att.id,
      filename: att.filename,
      fromArtifact: artifactId
    });
    return att;
  }

  /** Atomically create a new task seeded with a kept artifact copy. */
  createTaskFromArtifact(artifactId: string, input: CreateTaskInput): Task {
    const art = this.store.getArtifact(artifactId);
    if (!art) throw new CodedError(`artifact not found: ${artifactId}`, 'NOT_FOUND');
    if (art.state !== 'kept')
      throw new CodedError('only kept artifacts can be reused', 'BAD_REQUEST');
    const task = this.store.createTaskFromArtifact(artifactId, input);
    this.store.appendEvent(task.id, null, 'task_created', { title: task.title });
    return task;
  }

  /** Reveal a preserved scratch workspace (path resolved from the task row, never the renderer). */
  revealTaskWorkspace(taskId: string): string | null {
    const task = this.requireTask(taskId);
    if (task.workspaceKind !== 'scratch' || !task.workspacePath) return null;
    return task.workspacePath;
  }

  /** Explicitly delete preserved scratch leftovers after the archive warning. Guarded in the store. */
  discardTaskWorkspaceLeftovers(taskId: string): void {
    const task = this.requireTask(taskId);
    if (task.workspaceKind !== 'scratch') {
      throw new CodedError('only scratch workspaces can be discarded', 'BAD_REQUEST');
    }
    if (task.status !== 'archived') {
      throw new CodedError('only archived tasks can have their workspace discarded', 'BAD_REQUEST');
    }
    const deleted = this.store.deleteScratchWorkspace(taskId);
    if (deleted) {
      this.store.appendEvent(taskId, null, 'artifacts_unregistered_discarded', {});
    }
  }

  link(parentId: string, childId: string): void {
    this.requireTask(parentId);
    this.requireTask(childId);
    this.store.addLink(parentId, childId);
    this.store.appendEvent(childId, null, 'link_added', { parentId });
  }

  unlink(parentId: string, childId: string): void {
    this.requireTask(parentId);
    this.requireTask(childId);
    this.store.removeLink(parentId, childId);
    this.store.appendEvent(childId, null, 'link_removed', { parentId });
  }

  log(id: string): TaskEvent[] {
    this.requireTask(id);
    return this.store.listEvents(id);
  }

  requestDecompose(id: string): void {
    this.requestOrchestration(id, 'decompose');
  }

  requestSpecify(id: string): void {
    this.requestOrchestration(id, 'specify');
  }

  private requestOrchestration(id: string, mode: PendingMode): void {
    const task = this.requireTask(id);
    if (task.status !== 'triage') {
      throw new CodedError('only triage tasks can be decomposed or specified', 'BAD_REQUEST');
    }
    this.store.setPendingMode(id, mode);
    this.store.appendEvent(
      id,
      null,
      mode === 'decompose' ? 'decompose_requested' : 'specify_requested',
      {}
    );
  }

  setSchedule(id: string, input: ScheduleInput): void {
    this.requireTask(id);
    const v = validateSchedule(input);
    if (!v.ok) throw new CodedError(v.error, 'BAD_REQUEST');
    this.store.setSchedule(id, input);
    this.store.appendEvent(id, null, 'schedule_set', {
      kind: input.kind,
      expr: input.kind === 'cron' ? input.expr : undefined,
      everyMs: input.kind === 'interval' ? input.everyMs : undefined,
      at: input.kind === 'once' ? input.at : undefined
    });
  }

  clearSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null) return; // nothing to clear; don't emit a phantom event
    this.store.clearSchedule(id);
    this.store.appendEvent(id, null, 'schedule_cleared', {});
  }

  pauseSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null || t.scheduleKind === 'once') {
      throw new CodedError('only recurring schedules can be paused', 'BAD_REQUEST');
    }
    if (t.schedulePaused) return; // already paused — idempotent no-op
    this.store.pauseSchedule(id);
    this.store.appendEvent(id, null, 'schedule_paused', {});
  }

  resumeSchedule(id: string): void {
    const t = this.requireTask(id);
    if (t.scheduleKind == null || t.scheduleKind === 'once') {
      throw new CodedError('only recurring schedules can be resumed', 'BAD_REQUEST');
    }
    if (!t.schedulePaused) return; // not paused — idempotent no-op
    this.store.resumeSchedule(id);
    this.store.appendEvent(id, null, 'schedule_resumed', {});
  }

  /** Compute the next ~3 fire times for a candidate schedule (drawer live preview). */
  previewSchedule(
    input: ScheduleInput
  ): { ok: true; next: number[] } | { ok: false; error: string } {
    const v = validateSchedule(input);
    if (!v.ok) return { ok: false, error: v.error };
    const next: number[] = [];
    let after = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const n = computeNextRun(input, after);
      next.push(n);
      after = n;
      if (input.kind === 'once') break; // a one-shot fires exactly once
    }
    return { ok: true, next };
  }

  /** Shared validation: a review task with a complete worktree + base branch. */
  private requireMergeableReviewTask(id: string): Task & {
    workspacePath: string;
    repoPath: string;
    branchName: string;
    baseBranch: string;
  } {
    const task = this.requireTask(id);
    if (task.status !== 'review') {
      throw new CodedError('task is not awaiting review', 'BAD_REQUEST');
    }
    if (
      task.workspaceKind !== 'worktree' ||
      !task.workspacePath ||
      !task.repoPath ||
      !task.branchName ||
      !task.baseBranch
    ) {
      throw new CodedError('task has no worktree branch to integrate', 'BAD_REQUEST');
    }
    return task as Task & {
      workspacePath: string;
      repoPath: string;
      branchName: string;
      baseBranch: string;
    };
  }

  /** Merge a review task's branch into its base, then accept it (done). */
  mergeReviewTask(id: string): KanbanReviewActionResult {
    const task = this.requireMergeableReviewTask(id);
    const result = mergeWorktreeToBase({
      repoPath: task.repoPath,
      branchName: task.branchName,
      baseBranch: task.baseBranch,
      worktreeParentDir: dirname(task.workspacePath),
      taskId: task.id,
      title: task.title
    });
    if (!result.ok) {
      const reason = result.conflict
        ? `merge conflict against ${task.baseBranch}; resolve manually or unblock to retry`
        : (result.error ?? 'merge failed');
      this.store.addComment(id, 'human', `merge to ${task.baseBranch} failed: ${reason}`);
      this.store.appendEvent(id, null, 'merge_failed', {
        base: task.baseBranch,
        conflict: !!result.conflict
      });
      return { ok: false, conflict: result.conflict, error: reason };
    }
    this.store.completeTask(id, task.result);
    this.store.addComment(id, 'human', `merged ${task.branchName} into ${task.baseBranch}`);
    this.store.appendEvent(id, null, 'merged', {
      base: task.baseBranch,
      branch: task.branchName
    });
    // Auto-prune: the branch is now in base, so the worktree is spent disk. Reclaim it
    // (removeWorktree only deletes the merged branch; it never destroys unmerged work).
    removeWorktree({
      repoPath: task.repoPath,
      workspacePath: task.workspacePath,
      branchName: task.branchName,
      baseBranch: task.baseBranch
    });
    this.store.setWorktreePruned(id);
    this.store.appendEvent(id, null, 'worktree_pruned', { branch: task.branchName, by: 'merge' });
    // Base advanced — let gated children promote without waiting for the next poll.
    this.dispatcher.tick();
    return { ok: true, message: `merged into ${task.baseBranch}` };
  }

  /** Push a review task's branch and open a PR, then accept it (done). */
  createPrForTask(id: string): KanbanReviewActionResult {
    const task = this.requireMergeableReviewTask(id);
    const result = pushAndCreatePr({
      workspacePath: task.workspacePath,
      branchName: task.branchName,
      baseBranch: task.baseBranch,
      title: task.title,
      body: task.body
    });
    if (!result.ok) {
      this.store.addComment(id, 'human', `PR creation failed: ${result.error}`);
      this.store.appendEvent(id, null, 'pr_failed', { error: result.error });
      return { ok: false, error: result.error };
    }
    this.store.completeTask(id, task.result);
    if (result.url) this.store.setPr(id, result.url, result.number ?? null);
    this.store.addComment(id, 'human', `opened pull request: ${result.url}`);
    this.store.appendEvent(id, null, 'pr_created', { url: result.url, number: result.number });
    // Task accepted (done) — promote any gated children without waiting for the poll.
    this.dispatcher.tick();
    return { ok: true, prUrl: result.url, message: 'pull request created' };
  }

  /** Accept a review task without integrating (Do Nothing): branch + worktree are preserved. */
  acceptReviewTask(id: string): KanbanReviewActionResult {
    const task = this.requireTask(id);
    if (task.status !== 'review') {
      throw new CodedError('task is not awaiting review', 'BAD_REQUEST');
    }
    this.store.completeTask(id, task.result);
    const where = task.branchName
      ? `${task.branchName}${task.workspacePath ? ` at ${task.workspacePath}` : ''}`
      : 'workspace';
    this.store.addComment(id, 'human', `accepted without integration; branch preserved: ${where}`);
    this.store.appendEvent(id, null, 'accepted', { branch: task.branchName });
    // Task accepted (done) — promote any gated children without waiting for the poll.
    this.dispatcher.tick();
    return { ok: true, message: 'accepted; branch preserved' };
  }

  /**
   * Predict whether a worktree task's branch will merge cleanly into its base
   * (the feature integration branch, for feature tasks) and persist the result so
   * the board/drawer can warn before the merge is attempted. A no-op for tasks
   * without a worktree branch + base.
   */
  checkConflictsForTask(id: string): { state: ConflictState | null; files: string[] } {
    const task = this.requireTask(id);
    if (
      task.workspaceKind !== 'worktree' ||
      !task.repoPath ||
      !task.branchName ||
      !task.baseBranch
    ) {
      return { state: null, files: [] };
    }
    const res = checkMergeConflicts({
      repoPath: task.repoPath,
      baseBranch: task.baseBranch,
      branchName: task.branchName
    });
    this.store.setTaskConflict(id, res.state, res.files);
    this.store.appendEvent(id, null, 'conflict_checked', {
      state: res.state,
      files: res.files.length
    });
    return res;
  }

  // ---- Worktree lifecycle (Phase 4) ----

  /** Live worktrees on the board with ahead/behind/merged status, linked to their tasks. */
  listWorktrees(boardId: string): WorktreeInfo[] {
    return this.store.worktreeTasks({ boardId }).map((task) => {
      const { repoPath, branchName, baseBranch } = task;
      const st =
        repoPath && branchName && baseBranch
          ? worktreeStatus({ repoPath, branchName, baseBranch })
          : { ahead: 0, behind: 0, merged: false };
      return {
        taskId: task.id,
        title: task.title,
        status: task.status,
        repoPath: task.repoPath ?? '',
        workspacePath: task.workspacePath ?? '',
        branchName: task.branchName,
        baseBranch: task.baseBranch,
        ahead: st.ahead,
        behind: st.behind,
        merged: st.merged
      };
    });
  }

  /**
   * Remove a single task's worktree on demand. Refuses while a worker is running or the
   * task is still in the review gate (its worktree is needed to merge/PR); an unmerged
   * branch is preserved (removeWorktree keeps it), surfaced via `branchKept` so the caller
   * can warn.
   */
  pruneWorktree(id: string): KanbanPruneWorktreeResult {
    const task = this.requireTask(id);
    if (task.status === 'running' || task.status === 'review') {
      return {
        ok: false,
        error: `cannot prune while the task is ${task.status}; finish it first`
      };
    }
    if (task.workspaceKind !== 'worktree' || !task.workspacePath || !task.repoPath) {
      return { ok: false, error: 'task has no worktree to prune' };
    }
    const { branchKept } = removeWorktree({
      repoPath: task.repoPath,
      workspacePath: task.workspacePath,
      branchName: task.branchName,
      baseBranch: task.baseBranch
    });
    this.store.setWorktreePruned(id);
    this.store.appendEvent(id, null, 'worktree_pruned', { branch: task.branchName, by: 'manual' });
    if (branchKept && task.branchName) {
      this.store.appendEvent(id, null, 'unmerged_branch_kept', { branch: task.branchName });
    }
    return { ok: true, branchKept };
  }

  /**
   * Prune every merged worktree among the board's finished (done/archived) tasks,
   * leaving unmerged ones untouched. Only needs the merge predicate, so it queries the
   * store directly rather than computing ahead/behind via listWorktrees.
   */
  pruneMergedWorktrees(boardId: string): PruneResult {
    let pruned = 0;
    let keptUnmerged = 0;
    for (const task of this.store.worktreeTasks({ boardId, statuses: ['done', 'archived'] })) {
      if (!task.workspacePath || !task.repoPath || !task.branchName || !task.baseBranch) continue;
      const merged = isBranchMerged({
        repoPath: task.repoPath,
        branchName: task.branchName,
        baseBranch: task.baseBranch
      });
      if (!merged) {
        keptUnmerged++;
        continue;
      }
      removeWorktree({
        repoPath: task.repoPath,
        workspacePath: task.workspacePath,
        branchName: task.branchName,
        baseBranch: task.baseBranch
      });
      this.store.setWorktreePruned(task.id);
      this.store.appendEvent(task.id, null, 'worktree_pruned', {
        branch: task.branchName,
        by: 'bulk'
      });
      pruned++;
    }
    return { pruned, keptUnmerged };
  }

  // ---- Features (task grouping) ----

  private requireFeature(id: string): Feature {
    const f = this.store.getFeature(id);
    if (!f) throw new CodedError(`feature not found: ${id}`, 'NOT_FOUND');
    return f;
  }

  private requireBoard(slug: string): void {
    if (!this.store.listBoards().some((b) => b.slug === slug)) {
      throw new CodedError(`board not found: ${slug}`, 'NOT_FOUND');
    }
  }

  listFeatures(filter: { boardId?: string; status?: FeatureStatus } = {}): Feature[] {
    return this.store.listFeatures(filter);
  }

  showFeature(id: string): FeatureDetail | null {
    const feature = this.store.getFeature(id);
    if (!feature) return null;
    return {
      feature,
      tasks: this.store.listFeatureTasks(id),
      rollup: this.store.featureRollup(id)
    };
  }

  createFeature(input: CreateFeatureInput): Feature {
    const name = (input.name ?? '').trim();
    if (name === '') throw new CodedError('feature requires a name', 'BAD_REQUEST');
    this.requireBoard(input.boardId);
    const feature = this.store.createFeature({ ...input, name });
    this.store.appendEvent(feature.id, null, 'feature_created', { name });
    return feature;
  }

  updateFeature(id: string, fields: UpdateFeatureInput): void {
    this.requireFeature(id);
    if (fields.name !== undefined && fields.name.trim() === '') {
      throw new CodedError('feature requires a name', 'BAD_REQUEST');
    }
    this.store.updateFeature(id, {
      ...fields,
      name: fields.name?.trim()
    });
  }

  archiveFeature(id: string): void {
    this.requireFeature(id);
    const running = this.store.listFeatureTasks(id).some((t) => t.status === 'running');
    if (running) {
      throw new CodedError('stop running tasks before archiving this feature', 'BAD_REQUEST');
    }
    this.store.archiveFeature(id);
  }

  /** Hard delete: member tasks are detached (feature_id nulled), then the feature row is removed. */
  deleteFeature(id: string): void {
    this.requireFeature(id);
    const running = this.store.listFeatureTasks(id).some((t) => t.status === 'running');
    if (running) {
      throw new CodedError('stop running tasks before deleting this feature', 'BAD_REQUEST');
    }
    this.store.deleteFeature(id);
  }

  /** Add or clear a task's feature membership. Cross-board membership is rejected. */
  assignTaskToFeature(taskId: string, featureId: string | null): void {
    const task = this.requireTask(taskId);
    if (featureId !== null) {
      const feature = this.requireFeature(featureId);
      if (feature.boardId !== task.boardId) {
        throw new CodedError('task and feature belong to different boards', 'BAD_REQUEST');
      }
    }
    this.store.assignTaskToFeature(taskId, featureId);
    this.store.appendEvent(taskId, null, 'feature_assigned', { featureId });
  }

  /**
   * Re-run decompose for a feature whose triage orchestrator only created some tasks.
   * Reuses an existing triage task in the feature when present; otherwise creates a fresh
   * triage task seeded with the feature's existing tasks so the orchestrator has context
   * and can fill the gaps (dedup is the orchestrator's responsibility).
   */
  redecompose(featureId: string): Task {
    const feature = this.requireFeature(featureId);
    if (feature.status !== 'active') {
      throw new CodedError('only active features can be decomposed', 'BAD_REQUEST');
    }
    const tasks = this.store.listFeatureTasks(featureId);
    if (tasks.length === 0) {
      throw new CodedError('feature has no tasks to decompose from', 'BAD_REQUEST');
    }
    // Prefer an existing triage task in the feature (the original orchestrator card).
    const existingTriage = tasks.find((t) => t.status === 'triage');
    if (existingTriage) {
      this.requestDecompose(existingTriage.id);
      this.dispatcher.tick();
      return existingTriage;
    }
    // None in triage — create a new orchestrator card listing the existing work.
    const summary = tasks
      .map((t) => `- ${t.id} [${t.status}] ${t.title}`)
      .join('\n');
    const body = `Continue decomposing feature "${feature.name}". Existing tasks (avoid duplicates):\n\n${summary}`;
    const workspace =
      feature.repoPath != null
        ? {
            workspaceKind: 'worktree' as const,
            repoPath: feature.repoPath,
            baseBranch: feature.baseBranch
          }
        : { workspaceKind: 'scratch' as const };
    const triage = this.create({
      title: `Decompose: ${feature.name}`,
      body,
      status: 'triage',
      boardId: feature.boardId,
      featureId,
      ...workspace
    });
    this.requestDecompose(triage.id);
    this.dispatcher.tick();
    return triage;
  }

  /** Shared guard: a feature with the repo + integration branch needed for git ops. */
  private requireShippableFeature(id: string): {
    feature: Feature;
    repoPath: string;
    integrationBranch: string;
    baseBranch: string;
  } {
    const feature = this.requireFeature(id);
    if (!feature.repoPath) {
      throw new CodedError('feature has no repo to ship from', 'BAD_REQUEST');
    }
    if (!feature.integrationBranch) {
      throw new CodedError(
        'feature has no integration branch yet; run a worktree task in it first',
        'BAD_REQUEST'
      );
    }
    // Integration was cut from baseBranch; default to main when the feature left it unset.
    return {
      feature,
      repoPath: feature.repoPath,
      integrationBranch: feature.integrationBranch,
      baseBranch: feature.baseBranch ?? 'main'
    };
  }

  /** Refresh a feature's integration branch with the latest base (main). */
  syncFeatureWithMain(featureId: string): KanbanReviewActionResult {
    const { repoPath, integrationBranch, baseBranch } = this.requireShippableFeature(featureId);
    const res = updateIntegrationBranchFromMain({ repoPath, integrationBranch, baseBranch });
    if (!res.ok) {
      const reason = res.conflict
        ? `${baseBranch} conflicts with ${integrationBranch}; resolve manually`
        : (res.error ?? 'sync failed');
      this.store.updateFeature(featureId, { mergeState: res.conflict ? 'conflict' : undefined });
      this.store.appendEvent(featureId, null, 'feature_sync_failed', { conflict: !!res.conflict });
      return { ok: false, conflict: res.conflict, error: reason };
    }
    this.store.appendEvent(featureId, null, 'feature_synced', {
      upToDate: !!res.alreadyUpToDate
    });
    return {
      ok: true,
      message: res.alreadyUpToDate ? `already up to date with ${baseBranch}` : `synced with ${baseBranch}`
    };
  }

  /** Open the single feature→main PR for a whole feature (syncs with main first). */
  shipFeature(featureId: string): KanbanReviewActionResult {
    const { feature, repoPath, integrationBranch, baseBranch } =
      this.requireShippableFeature(featureId);
    // Pre-flight: bring the integration branch up to date so the PR is mergeable.
    const sync = updateIntegrationBranchFromMain({ repoPath, integrationBranch, baseBranch });
    if (!sync.ok) {
      const reason = sync.conflict
        ? `${baseBranch} conflicts with ${integrationBranch}; resolve before shipping`
        : (sync.error ?? 'sync failed');
      this.store.appendEvent(featureId, null, 'feature_sync_failed', { conflict: !!sync.conflict });
      return { ok: false, conflict: sync.conflict, error: reason };
    }
    const res = createFeaturePr({
      repoPath,
      integrationBranch,
      baseBranch,
      title: feature.name,
      body: `Ships feature "${feature.name}".`
    });
    if (!res.ok) {
      this.store.appendEvent(featureId, null, 'feature_pr_failed', { error: res.error });
      return { ok: false, error: res.error };
    }
    if (res.url) this.store.setFeaturePr(featureId, res.url, res.number ?? null);
    this.store.updateFeature(featureId, { mergeState: 'in_progress' });
    this.store.appendEvent(featureId, null, 'feature_pr_created', {
      url: res.url,
      number: res.number
    });
    return { ok: true, prUrl: res.url, message: 'feature pull request opened' };
  }

  dispatch(): void {
    this.dispatcher.tick();
  }

  // ---- Projects (board folder registry) ----

  listProjects(boardId: string): Project[] {
    this.requireBoard(boardId);
    return this.store.listProjects(boardId);
  }

  addProject(input: {
    boardId: string;
    name: string;
    path: string;
    description?: string | null;
  }): Project {
    this.requireBoard(input.boardId);
    const name = (input.name ?? '').trim();
    if (name === '') throw new CodedError('project requires a name', 'BAD_REQUEST');
    let stat;
    try {
      stat = statSync(input.path);
    } catch {
      throw new CodedError(`project path does not exist: ${input.path}`, 'BAD_REQUEST');
    }
    if (!stat.isDirectory()) {
      throw new CodedError(`project path is not a directory: ${input.path}`, 'BAD_REQUEST');
    }
    const existing = this.store.listProjects(input.boardId);
    if (existing.some((p) => p.name === name)) {
      throw new CodedError(`a project named "${name}" already exists on this board`, 'BAD_REQUEST');
    }
    if (existing.some((p) => p.path === input.path)) {
      throw new CodedError(`this folder is already registered on this board`, 'BAD_REQUEST');
    }
    const description = input.description?.trim() || null;
    return this.store.addProject({ boardId: input.boardId, name, path: input.path, description });
  }

  removeProject(id: string): void {
    if (!this.store.getProject(id)) throw new CodedError(`project not found: ${id}`, 'NOT_FOUND');
    this.store.removeProject(id);
  }

  setDefaultProject(id: string): void {
    if (!this.store.getProject(id)) throw new CodedError(`project not found: ${id}`, 'NOT_FOUND');
    this.store.setDefaultProject(id);
  }
}
