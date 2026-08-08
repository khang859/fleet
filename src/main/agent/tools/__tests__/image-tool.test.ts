import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUTPUT_SEPARATOR,
  type AgentImageRequest,
  type AgentToolContext
} from '../../../../shared/agent-tools';
import { AgentImageStore } from '../../image-store';
import { runImage } from '../image';

const THREAD = '11111111-2222-4333-8444-555555555555';

let cwd: string;
let imagesRoot: string;
let store: AgentImageStore;
/** What the generator was asked for, so a test can check what reached it. */
let asked: AgentImageRequest[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-image-cwd-'));
  imagesRoot = mkdtempSync(join(tmpdir(), 'agent-image-store-'));
  store = new AgentImageStore(imagesRoot);
  asked = [];
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(imagesRoot, { recursive: true, force: true });
});

/** A generator that always succeeds, and records what it was handed. */
const works =
  (costUsd: number | null = 0.04) =>
  async (req: AgentImageRequest) => {
    asked.push(req);
    return Promise.resolve({ data: Buffer.from('the image'), mimeType: 'image/png', costUsd });
  };

const ctx = (generateImage: AgentToolContext['generateImage']): AgentToolContext => ({
  cwd,
  threadId: THREAD,
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(true),
  wasRefused: () => false,
  generateImage,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  findSkill: null,
  todos: { list: () => [], save: () => {} }
});

/** A file in the working folder, for the tests about references. */
function file(rel: string, contents = 'bytes'): string {
  const path = join(cwd, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe('image', () => {
  it('generates, saves, and reports the path twice - once for each reader', async () => {
    const result = await runImage({ prompt: 'a teal officer cap' }, ctx(works()), store);

    const [forModel, forPane] = result.text.split(`${OUTPUT_SEPARATOR}\n`);
    // The model is told where it went and what it cost.
    expect(forModel).toContain('Generated an image and saved it to');
    expect(forModel).toContain('$0.04');
    // The pane gets the path alone, which is what it draws the image from.
    expect(forPane.trim().startsWith(imagesRoot)).toBe(true);
    expect(result.summary).toBe('$0.04');
  });

  it('says "saved" when the provider did not price the call', async () => {
    const result = await runImage({ prompt: 'x' }, ctx(works(null)), store);
    expect(result.summary).toBe('saved');
  });

  it('explains itself when no image model is configured', async () => {
    await expect(runImage({ prompt: 'x' }, ctx(null), store)).rejects.toThrow(
      'Image generation is off'
    );
  });

  it('inlines a reference from the working folder as a data URL', async () => {
    file('assets/logo.png', 'logo bytes');

    const result = await runImage(
      { prompt: 'the same logo in navy', references: ['assets/logo.png'] },
      ctx(works()),
      store
    );

    expect(asked[0].references).toEqual([
      `data:image/png;base64,${Buffer.from('logo bytes').toString('base64')}`
    ]);
    // An edit says so, because the row would otherwise read as a fresh picture.
    expect(result.text).toContain('Edited an image');
  });

  it('can edit an image it generated earlier, which lives outside the folder', async () => {
    const earlier = store.save(THREAD, Buffer.from('earlier'), 'image/png');

    await runImage({ prompt: 'again, warmer', references: [earlier] }, ctx(works()), store);

    expect(asked[0].references).toEqual([
      `data:image/png;base64,${Buffer.from('earlier').toString('base64')}`
    ]);
  });

  it('refuses a reference outside the working folder', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'elsewhere-')), 'secret.png');
    writeFileSync(outside, 'not yours');

    await expect(
      runImage({ prompt: 'x', references: [outside] }, ctx(works()), store)
    ).rejects.toThrow('outside the working folder');
  });

  it('refuses a reference that is not an image, however it is spelled', async () => {
    file('.env', 'OPENROUTER_KEY=sk-real');

    await expect(
      runImage({ prompt: 'x', references: ['.env'] }, ctx(works()), store)
    ).rejects.toThrow('not an image');
    await expect(
      runImage({ prompt: 'x', references: ['../../../etc/passwd'] }, ctx(works()), store)
    ).rejects.toThrow('not an image');
  });

  it('refuses a reference that is not there, rather than sending nothing', async () => {
    await expect(
      runImage({ prompt: 'x', references: ['missing.png'] }, ctx(works()), store)
    ).rejects.toThrow('does not exist');
  });

  it('passes the aspect ratio through and defaults it to nothing', async () => {
    await runImage({ prompt: 'x', aspectRatio: '16:9' }, ctx(works()), store);
    expect(asked[0].aspectRatio).toBe('16:9');

    await runImage({ prompt: 'x' }, ctx(works()), store);
    expect(asked[1].aspectRatio).toBeNull();
  });
});
