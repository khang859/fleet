import type { TaskEvent } from '../../shared/kanban-types';
import { classifyKanbanEvent, type KanbanNotifyCategory } from '../../shared/kanban-notifications';

export interface KanbanNotificationPayload {
  body: string;
  boardSlug: string;
  taskId?: string;
}

export interface KanbanNotifierDeps {
  /** Whether the category's OS notification toggle is on (read fresh each call). */
  isOsEnabled: (category: KanbanNotifyCategory) => boolean;
  /** Resolve a task's title + board, or null if it no longer exists. */
  getTask: (taskId: string) => { title: string; boardId: string } | null;
  /** Resolve a feature's name + board (fallback for feature-keyed events), or null. */
  getFeature: (featureId: string) => { name: string; boardId: string } | null;
  /** Present one (possibly coalesced) notification. */
  present: (payload: KanbanNotificationPayload) => void;
  /** Coalescing window in ms (default 500). */
  batchMs?: number;
}

interface BufferItem {
  category: KanbanNotifyCategory;
  taskId: string;
  boardSlug: string;
  title: string;
}

const LABEL: Record<KanbanNotifyCategory, string> = {
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
  scheduleFired: 'Scheduled'
};

const COUNT_WORD: Record<KanbanNotifyCategory, string> = {
  blocked: 'blocked',
  failed: 'failed',
  completed: 'completed',
  scheduleFired: 'scheduled'
};

// Highest priority first — drives burst click target + count ordering.
const PRIORITY: readonly KanbanNotifyCategory[] = [
  'blocked',
  'failed',
  'completed',
  'scheduleFired'
];

export class KanbanNotifier {
  private buffer: BufferItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchMs: number;

  constructor(private readonly deps: KanbanNotifierDeps) {
    this.batchMs = deps.batchMs ?? 500;
  }

  enqueue(event: TaskEvent): void {
    const category = classifyKanbanEvent(event.kind);
    if (!category) return;
    if (!this.deps.isOsEnabled(category)) return;
    const subject = this.deps.getTask(event.taskId) ?? this.deps.getFeature(event.taskId);
    if (!subject) return;
    this.buffer.push({
      category,
      taskId: event.taskId,
      boardSlug: subject.boardId,
      title: 'title' in subject ? subject.title : subject.name
    });
    this.timer ??= setTimeout(() => this.flush(), this.batchMs);
  }

  /** Build and present one notification from the buffered items. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return;

    if (batch.length === 1) {
      const item = batch[0];
      this.deps.present({
        body: `${LABEL[item.category]}: ${item.title}`,
        boardSlug: item.boardSlug,
        taskId: item.taskId
      });
      return;
    }

    // Burst: count per category in priority order; click target = highest-priority item.
    const parts: string[] = [];
    for (const cat of PRIORITY) {
      const n = batch.filter((b) => b.category === cat).length;
      if (n > 0) parts.push(`${n} ${COUNT_WORD[cat]}`);
    }
    const lead =
      PRIORITY.map((cat) => batch.find((b) => b.category === cat)).find((b) => b != null) ??
      batch[0];
    this.deps.present({
      body: `${batch.length} task updates: ${parts.join(', ')}`,
      boardSlug: lead.boardSlug
    });
  }
}
