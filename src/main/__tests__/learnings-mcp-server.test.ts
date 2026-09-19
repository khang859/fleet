import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'http';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LearningsStore } from '../learnings/learnings-store';
import { LearningsSearchService } from '../learnings/search-service';
import { LearningsMcpServer } from '../learnings/learnings-mcp-server';
import { FakeEmbedder } from '../learnings/embedder';

const TEST_DIR = join(tmpdir(), `fleet-learnings-mcp-test-${Date.now()}`);

describe('LearningsMcpServer', () => {
  let store: LearningsStore;
  let server: LearningsMcpServer;
  let url: string;
  let port: number;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new LearningsStore(join(TEST_DIR, 'learnings.db'));
    const search = new LearningsSearchService(store, new FakeEmbedder());
    server = new LearningsMcpServer(store, search);
    port = await server.start(0);
    url = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const rpc = async (method: string, params?: unknown): Promise<any> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return res.json();
  };

  it('advertises the two tools', async () => {
    const out = await rpc('tools/list');
    expect(out.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'learnings_search',
      'learnings_get'
    ]);
  });

  it('learnings_search returns matching learnings as text with ids', async () => {
    const l = store.create({ title: 'xterm sizing gotcha', body: 'fit addon padding' });
    const out = await rpc('tools/call', {
      name: 'learnings_search',
      arguments: { query: 'xterm sizing', limit: 5 }
    });
    const text = out.result.content[0].text;
    expect(text).toContain('xterm sizing gotcha');
    expect(text).toContain(l.id);
  });

  it('learnings_search reports no matches cleanly', async () => {
    store.create({ title: 'something', body: 'else' });
    const out = await rpc('tools/call', {
      name: 'learnings_search',
      arguments: { query: 'zzzznomatch' }
    });
    expect(out.result.content[0].text).toBe('No matching learnings found.');
  });

  it('learnings_get returns full markdown, or an error for an unknown id', async () => {
    const l = store.create({ title: 'WAL mode', body: 'concurrency', tags: ['sqlite'] });
    const ok = await rpc('tools/call', { name: 'learnings_get', arguments: { id: l.id } });
    expect(ok.result.content[0].text).toContain('# WAL mode');
    expect(ok.result.content[0].text).toContain('Tags: sqlite');

    const missing = await rpc('tools/call', { name: 'learnings_get', arguments: { id: 'nope' } });
    expect(missing.error.message).toContain('not found');
  });

  it('rejects invalid tool arguments via zod', async () => {
    const out = await rpc('tools/call', { name: 'learnings_search', arguments: {} });
    expect(out.error).toBeDefined();
  });

  it('errors on an unknown tool', async () => {
    const out = await rpc('tools/call', { name: 'nope', arguments: {} });
    expect(out.error.message).toContain('unknown tool');
  });

  it('rejects an over-limit request body with 413 instead of buffering it', async () => {
    // > 1 MiB body — must be refused before it can exhaust the main process heap.
    const huge = 'a'.repeat(1024 * 1024 + 1);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: huge })
    });
    expect(res.status).toBe(413);
  });

  /** Raw POST so the Host header can be forged (fetch forbids setting it). */
  const post = async (headers: Record<string, string>, path = '/mcp'): Promise<number> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(body);
    });

  it('accepts a normal request with Host 127.0.0.1 or localhost', async () => {
    const json = { 'Content-Type': 'application/json' };
    expect(await post({ ...json, Host: `127.0.0.1:${port}` })).toBe(200);
    expect(await post({ ...json, Host: `localhost:${port}` })).toBe(200);
  });

  it('rejects a foreign Host header with 403 (DNS rebinding)', async () => {
    const status = await post({ 'Content-Type': 'application/json', Host: `evil.example:${port}` });
    expect(status).toBe(403);
  });

  it('rejects any request carrying an Origin header with 403', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(res.status).toBe(403);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const status = await post({ 'Content-Type': 'text/plain', Host: `127.0.0.1:${port}` });
    expect(status).toBe(415);
  });

  it('only serves the /mcp path', async () => {
    const status = await post({ 'Content-Type': 'application/json' }, '/other');
    expect(status).toBe(404);
  });

  it('rejects non-POST methods', async () => {
    const res = await fetch(url, { method: 'GET' });
    expect(res.status).toBe(405);
  });
});
