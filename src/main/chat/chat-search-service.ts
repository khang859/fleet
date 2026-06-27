// src/main/chat/chat-search-service.ts
import { createLogger } from '../logger';
import { reciprocalRankFusion } from '../learnings/search-service';
import type { Embedder } from '../learnings/embedder';
import type { ChatStore } from './chat-store';
import type { ChatSearchHit } from '../../shared/chat-types';

const log = createLogger('chat-search');

/** Default cap on returned hits — bounds the IPC payload and the sidebar list. */
const SEARCH_LIMIT = 50;

/** Collapse free text to a single line and clip it to a sidebar-sized snippet. */
function makeSnippet(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Coordinates keyword (FTS5) + semantic (vector) retrieval over chat messages into
 * one ranked list of conversations. Vector hits are per-message, so they're collapsed
 * to their conversation (nearest message wins) before fusion. Degrades to FTS-only
 * whenever the embedder is unavailable or the query is empty — semantic search is an
 * enhancement, never a hard dependency.
 */
export class ChatSearchService {
  constructor(
    private readonly store: ChatStore,
    private readonly embedder: Embedder
  ) {}

  async hybridSearch(query: string, limit = SEARCH_LIMIT): Promise<ChatSearchHit[]> {
    const safeLimit = Math.max(1, limit);
    const fts = this.store.searchConversations(query);

    if (!query.trim() || !this.store.hasVectorSupport()) return fts.slice(0, safeLimit);

    const vec = await this.embedder.embed(query);
    if (!vec) return fts.slice(0, safeLimit);

    // Per-message neighbors collapse to far fewer conversations, so over-fetch wider
    // than `limit` to give fusion room to reorder.
    const poolSize = Math.max(safeLimit * 8, 60);
    const vecHits = this.store.messageVectorSearch(vec, poolSize);

    // Collapse to conversation order (first/nearest message per conversation wins) and
    // remember that message's content to snippet vector-only hits.
    const vecConvIds: string[] = [];
    const vecSnippet = new Map<string, string>();
    for (const h of vecHits) {
      if (vecSnippet.has(h.conversationId)) continue;
      vecConvIds.push(h.conversationId);
      vecSnippet.set(h.conversationId, h.content);
    }

    const fused = reciprocalRankFusion([fts.map((h) => h.conversationId), vecConvIds]);

    // Reuse the already-hydrated FTS hits (they carry a highlighted snippet); only
    // conversations that surfaced solely from the vector side need a title lookup.
    const byId = new Map(fts.map((h) => [h.conversationId, h]));
    const out: ChatSearchHit[] = [];
    for (const id of fused) {
      const existing = byId.get(id);
      if (existing) {
        out.push(existing);
      } else {
        const conv = this.store.getConversation(id);
        out.push({
          conversationId: id,
          title: conv?.title ?? 'Conversation',
          snippet: makeSnippet(vecSnippet.get(id) ?? '')
        });
      }
      if (out.length >= safeLimit) break;
    }
    return out;
  }

  /**
   * Embed one message in the background and store its vector. Fire-and-forget: a null
   * vector (embedder unavailable) leaves the row pending for the next backfill pass,
   * and any error is swallowed so indexing never disrupts the chat hot path.
   */
  scheduleEmbed(id: string, content: string): void {
    Promise.resolve(this.embedder.embed(content))
      .then((vec) => {
        if (vec) this.store.setEmbedding(id, vec);
      })
      .catch((err: unknown) => {
        log.warn('embed-on-write failed (will retry on next backfill)', {
          id,
          error: err instanceof Error ? err.message : String(err)
        });
      });
  }
}
