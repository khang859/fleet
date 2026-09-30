import { z } from 'zod';
import type { ClaudeUsageInput } from '../../shared/claude-pricing';
import type { ClaudeUsage } from '../../shared/sessions';

const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: z.number().optional(),
        ephemeral_1h_input_tokens: z.number().optional()
      })
      .partial()
      .optional()
  })
  .passthrough();

const assistantLineSchema = z
  .object({
    type: z.literal('assistant'),
    isSidechain: z.boolean().optional(),
    message: z
      .object({
        id: z.string().optional(),
        model: z.string().optional(),
        usage: usageSchema.optional()
      })
      .passthrough()
  })
  .passthrough();

const tsLineSchema = z
  .object({ timestamp: z.string().optional(), gitBranch: z.string().optional() })
  .passthrough();

/** How full the main conversation's context was at its latest assistant message. */
export type ContextUsage = {
  /** Input tokens the model saw: fresh input plus cache reads and writes. */
  tokens: number;
  model: string;
};

export type ClaudeAggregate = {
  total: ClaudeUsage;
  perModel: Map<string, ClaudeUsageInput>;
  models: string[];
  gitBranch?: string;
  startedAt?: number;
  endedAt?: number;
  hasUsage: boolean;
  /** From the last main-chain message with usage; subagents have their own context. */
  context: ContextUsage | null;
};

function emptyUsage(): ClaudeUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/**
 * Token usage from a Claude Code transcript, fed a line or a chunk at a time,
 * so a growing transcript is read once rather than re-scanned on each change.
 *
 * Dedups by `message.id`: Claude Code writes one line per content block, each
 * repeating the same usage object. Sidechain (subagent) usage is counted,
 * since it costs money, but does not move the context figure.
 */
export class UsageAccumulator {
  private readonly total = emptyUsage();
  private readonly perModel = new Map<string, ClaudeUsageInput>();
  private readonly models: string[] = [];
  private readonly seenIds = new Set<string>();
  private gitBranch: string | undefined;
  private startedAt: number | undefined;
  private endedAt: number | undefined;
  private hasUsage = false;
  private context: ContextUsage | null = null;
  /** Per source, the tail of its last chunk when that stopped partway through a line. */
  private readonly partials = new Map<string, string>();

  /**
   * Add raw transcript text. A trailing partial line waits for the next chunk
   * from the same `source`, so several files can be read into one total.
   */
  addText(chunk: string, source = ''): void {
    const lines = ((this.partials.get(source) ?? '') + chunk).split('\n');
    this.partials.set(source, lines.pop() ?? '');
    for (const line of lines) this.addLine(line);
  }

  /** Treat a source's held partial line as complete, for text known to end there. */
  flush(source = ''): void {
    const line = this.partials.get(source) ?? '';
    this.partials.delete(source);
    this.addLine(line);
  }

  addLine(line: string): void {
    if (!line) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }

    const ts = tsLineSchema.safeParse(json);
    if (ts.success) {
      if (this.gitBranch === undefined && ts.data.gitBranch) this.gitBranch = ts.data.gitBranch;
      if (ts.data.timestamp) {
        const t = Date.parse(ts.data.timestamp);
        if (!Number.isNaN(t)) {
          if (this.startedAt === undefined || t < this.startedAt) this.startedAt = t;
          if (this.endedAt === undefined || t > this.endedAt) this.endedAt = t;
        }
      }
    }

    const parsed = assistantLineSchema.safeParse(json);
    if (!parsed.success) return;
    const { message, isSidechain } = parsed.data;
    const u = message.usage;
    if (!u) return;
    const id = message.id;
    if (id && this.seenIds.has(id)) return;
    if (id) this.seenIds.add(id);

    // Without a model the tokens cannot be priced; skip rather than poison the cost.
    const model = message.model;
    if (!model) return;

    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    let write5m = 0;
    let write1h = 0;
    if (u.cache_creation) {
      write5m = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
      write1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
    } else {
      write5m = u.cache_creation_input_tokens ?? 0;
    }

    const seen = input + cacheRead + write5m + write1h;
    // Claude Code records an API error as a message from model `<synthetic>`
    // with no usage. Counting it would name a model no price table has and
    // leave the whole session unpriced.
    if (!seen && !output) return;
    this.hasUsage = true;
    if (!this.models.includes(model)) this.models.push(model);
    if (!isSidechain) this.context = { tokens: seen, model };

    add(this.total, input, output, cacheRead, write5m, write1h);
    const bucket = this.perModel.get(model) ?? emptyUsage();
    add(bucket, input, output, cacheRead, write5m, write1h);
    this.perModel.set(model, bucket);
  }

  /** A snapshot of everything added so far; later additions do not change it. */
  result(): ClaudeAggregate {
    return {
      total: { ...this.total },
      perModel: new Map([...this.perModel].map(([model, usage]) => [model, { ...usage }])),
      models: [...this.models],
      gitBranch: this.gitBranch,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      hasUsage: this.hasUsage,
      context: this.context
    };
  }
}

function add(
  into: ClaudeUsage,
  input: number,
  output: number,
  cacheRead: number,
  write5m: number,
  write1h: number
): void {
  into.input += input;
  into.output += output;
  into.cacheRead += cacheRead;
  into.cacheWrite5m += write5m;
  into.cacheWrite1h += write1h;
}

/** Aggregate a whole transcript at once. */
export function aggregateClaudeUsage(content: string): ClaudeAggregate {
  const acc = new UsageAccumulator();
  acc.addText(content);
  acc.flush();
  return acc.result();
}
