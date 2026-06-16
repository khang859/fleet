// src/main/learnings/search-service.ts
import type { Learning, LearningSearchFilter } from '../../shared/learnings';
import type { LearningsStore } from './learnings-store';
import type { Embedder } from './embedder';

/**
 * Reciprocal Rank Fusion: merge several ranked id lists into one, scoring each id by
 * Σ 1/(k + rank). Score-free (uses ordinal position only), so it fuses incommensurable
 * signals — FTS5 `rank` and vector distance — without normalization. k=60 per the
 * original RRF paper. Pure and dependency-free for easy testing.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function matchesFilter(l: Learning, filter: LearningSearchFilter): boolean {
  if (filter.project && l.sourceProject !== filter.project) return false;
  if (filter.tag && !l.tags.includes(filter.tag)) return false;
  return true;
}

/** Coordinates keyword (FTS5) + semantic (vector) retrieval into one ranked result. */
export class LearningsSearchService {
  constructor(
    private readonly store: LearningsStore,
    private readonly embedder: Embedder
  ) {}

  /**
   * Hybrid search. With no embedder/vector support (or an empty query) this is just
   * the store's FTS5 search; otherwise it fuses FTS5 and vector neighbors via RRF.
   */
  async hybridSearch(
    query: string,
    opts: LearningSearchFilter = {},
    limit = 10
  ): Promise<Learning[]> {
    // A non-positive limit would otherwise yield `[]` via slice semantics; clamp it.
    const safeLimit = Math.max(1, limit);
    const filter: LearningSearchFilter = { query, project: opts.project, tag: opts.tag };
    const fts = this.store.search(filter);

    if (!query.trim() || !this.store.hasVectorSupport()) return fts.slice(0, safeLimit);

    const vec = await this.embedder.embed(query);
    if (!vec) return fts.slice(0, safeLimit);

    // Pull a candidate pool wider than `limit` so fusion has room to reorder. Vector
    // neighbors ignore project/tag, so a selective filter discards most of them
    // post-fusion — widen the pool when a filter is present to avoid starving results.
    const filtered = Boolean(filter.project || filter.tag);
    const poolSize = filtered ? Math.max(safeLimit * 20, 100) : Math.max(safeLimit * 4, 20);
    const hits = this.store.vectorSearch(vec, poolSize);
    const fused = reciprocalRankFusion([fts.map((l) => l.id), hits.map((h) => h.id)]);

    // Reuse the already-hydrated FTS rows instead of re-fetching every fused id from
    // the store; only ids that came solely from the vector side need a `store.get`.
    const byId = new Map(fts.map((l) => [l.id, l]));
    const out: Learning[] = [];
    for (const id of fused) {
      const l = byId.get(id) ?? this.store.get(id);
      // Vector neighbors ignore project/tag — enforce the filter on the merged set.
      if (l && matchesFilter(l, filter)) out.push(l);
      if (out.length >= safeLimit) break;
    }
    return out;
  }
}
