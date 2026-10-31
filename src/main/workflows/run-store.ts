import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BoardItem, WorkflowRun } from '../../shared/workflows';
import { writeAtomicSync } from '../fs-atomic';
import { createLogger } from '../logger';

const log = createLogger('workflows:run-store');

/** The log is folded into a snapshot this often. */
const SNAPSHOT_EVERY = 50;

const BOARD_ITEM = z.object({
  id: z.string(),
  agent: z.string(),
  kind: z.string(),
  text: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  source: z.string().optional(),
  mergedFrom: z.array(z.string()).optional(),
  mergedInto: z.string().optional(),
  post: z.enum(['posting', 'posted', 'failed']).optional()
}) satisfies z.ZodType<BoardItem>;

const LOG_ENTRY = z.object({ seq: z.number(), item: BOARD_ITEM });
const SNAPSHOT = z.object({ seq: z.number(), items: z.array(BOARD_ITEM) });

type LogEntry = z.infer<typeof LOG_ENTRY>;
type Snapshot = z.infer<typeof SNAPSHOT>;

/**
 * One private folder per run, under Fleet's base folder, so a dev sandbox keeps
 * its own runs. A record per run is simpler than new tables, and a run has few
 * writes.
 */
export class RunStore {
  private readonly seqs = new Map<string, number>();

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  folder(runId: string): string {
    return join(this.root, runId);
  }

  /** Make the run's folder, with the approved bytes of its workflow. */
  create(runId: string, workflowBytes: string): string {
    const dir = this.folder(runId);
    mkdirSync(join(dir, 'prompts'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'workflow.toml'), workflowBytes, { mode: 0o600 });
    return dir;
  }

  /** Write a prompt file, and answer its absolute path. */
  writePrompt(runId: string, name: string, text: string): string {
    const path = join(this.folder(runId), 'prompts', name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  }

  workflowBytes(runId: string): string {
    return readFileSync(join(this.folder(runId), 'workflow.toml'), 'utf8');
  }

  /** The run record. The board lives in its own log, so it is left out. */
  save(run: WorkflowRun): void {
    const record = { ...run, board: undefined };
    writeAtomicSync(join(this.folder(run.id), 'run.json'), JSON.stringify(record, null, 2));
  }

  /** Append changed board items, safe on disk before the call returns. */
  appendBoard(runId: string, item: BoardItem): void {
    // A crash can leave half a line, so the first write of a launch starts a new one.
    const lead = this.seqs.has(runId) ? '' : '\n';
    const seq = (this.seqs.get(runId) ?? this.lastSeq(runId)) + 1;
    this.seqs.set(runId, seq);
    const path = join(this.folder(runId), 'board.log');
    const line = JSON.stringify({ seq, item } satisfies LogEntry);
    appendFileSync(path, `${lead}${line}\n`, { mode: 0o600 });
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (seq % SNAPSHOT_EVERY === 0) this.snapshot(runId, seq);
  }

  private snapshot(runId: string, seq: number): void {
    const items = this.loadBoard(runId);
    writeAtomicSync(
      join(this.folder(runId), 'board.json'),
      JSON.stringify({ seq, items } satisfies Snapshot)
    );
  }

  private lastSeq(runId: string): number {
    return this.readLog(runId).at(-1)?.seq ?? this.readSnapshot(runId).seq;
  }

  private readSnapshot(runId: string): Snapshot {
    try {
      const text = readFileSync(join(this.folder(runId), 'board.json'), 'utf8');
      return SNAPSHOT.parse(JSON.parse(text));
    } catch {
      return { seq: 0, items: [] };
    }
  }

  private readLog(runId: string): LogEntry[] {
    let text: string;
    try {
      text = readFileSync(join(this.folder(runId), 'board.log'), 'utf8');
    } catch {
      return [];
    }
    // A crash can leave half a line at the end. Every line before it is whole.
    return text.split('\n').flatMap((line) => {
      if (line === '') return [];
      try {
        return [LOG_ENTRY.parse(JSON.parse(line))];
      } catch {
        return [];
      }
    });
  }

  /** The board as the last write left it: the snapshot, then every later change in order. */
  loadBoard(runId: string): BoardItem[] {
    const snapshot = this.readSnapshot(runId);
    const items = new Map(snapshot.items.map((item) => [item.id, item]));
    for (const entry of this.readLog(runId)) {
      if (entry.seq > snapshot.seq) items.set(entry.item.id, entry.item);
    }
    return [...items.values()];
  }

  /** Every saved run, oldest first. A broken record is logged and left out. */
  loadAll(): WorkflowRun[] {
    let ids: string[];
    try {
      ids = readdirSync(this.root);
    } catch {
      return [];
    }
    const runs = ids.flatMap((id) => {
      try {
        const text = readFileSync(join(this.folder(id), 'run.json'), 'utf8');
        // Fleet wrote this record itself, under its own private folder.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const record = JSON.parse(text) as Omit<WorkflowRun, 'board'>;
        return [{ ...record, board: this.loadBoard(id) }];
      } catch (err) {
        log.warn('a run record could not be read', { runId: id, error: String(err) });
        return [];
      }
    });
    return runs.sort((a, b) => a.createdAt - b.createdAt);
  }
}
