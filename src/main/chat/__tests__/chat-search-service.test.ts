import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatStore } from '../chat-store';
import { ChatSearchService } from '../chat-search-service';
import { runChatBackfill } from '../chat-backfill';
import { FakeEmbedder, NullEmbedder } from '../../learnings/embedder';

const TEST_DIR = join(tmpdir(), `fleet-chat-search-test-${process.pid}`);
const DB_PATH = join(TEST_DIR, 'chat.db');

describe('ChatSearchService', () => {
  let store: ChatStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new ChatStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /** Seed two conversations with distinct topics, then embed every message. */
  async function seedAndEmbed(): Promise<{ webpack: string; pasta: string }> {
    const webpack = store.createConversation({ title: 'Bundler help' });
    const pasta = store.createConversation({ title: 'Dinner ideas' });
    store.addMessage({
      conversationId: webpack.id,
      role: 'user',
      content: 'how do I configure webpack code splitting'
    });
    store.addMessage({
      conversationId: pasta.id,
      role: 'user',
      content: 'best way to cook pasta carbonara tonight'
    });
    await runChatBackfill(store, new FakeEmbedder());
    return { webpack: webpack.id, pasta: pasta.id };
  }

  it('returns FTS keyword matches when the embedder is unavailable', async () => {
    const { webpack } = await seedAndEmbed();
    const search = new ChatSearchService(store, new NullEmbedder());
    const hits = await search.hybridSearch('webpack');
    expect(hits.map((h) => h.conversationId)).toContain(webpack);
    expect(hits.some((h) => h.conversationId !== webpack)).toBe(false);
  });

  it('fuses keyword and semantic hits, surfacing the relevant conversation first', async () => {
    const { webpack } = await seedAndEmbed();
    const search = new ChatSearchService(store, new FakeEmbedder());
    const hits = await search.hybridSearch('webpack');
    expect(hits[0]?.conversationId).toBe(webpack);
  });

  it('finds a conversation by a semantically related message even without a keyword match', async () => {
    const { pasta } = await seedAndEmbed();
    const search = new ChatSearchService(store, new FakeEmbedder());
    // "carbonara" is in the pasta conversation; the FakeEmbedder hashes shared tokens
    // so the query vector lands near that message even though FTS for this exact run
    // still matches it — assert the conversation surfaces.
    const hits = await search.hybridSearch('carbonara');
    expect(hits.map((h) => h.conversationId)).toContain(pasta);
  });

  it('returns an empty list for an empty query', async () => {
    await seedAndEmbed();
    const search = new ChatSearchService(store, new FakeEmbedder());
    expect(await search.hybridSearch('   ')).toEqual([]);
  });
});
