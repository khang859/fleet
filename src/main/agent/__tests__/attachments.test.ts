import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentWireParts, resolveAttachment } from '../attachments';
import { AgentImageStore } from '../image-store';
import type { AgentAttachRequest } from '../../../shared/agent-types';

// The reading itself is a worker thread, and a worker needs a built .mjs that
// does not exist while these run. What pdfjs makes of real bytes is
// `pdf/__tests__/extract.test.ts`'s subject; this file's is what happens to the
// answer once it comes back.
vi.mock('../pdf/parse', () => ({
  parsePdf: async (bytes: Uint8Array) =>
    Promise.resolve(
      bytes.byteLength === 0
        ? { text: '', pages: 1, scanned: true }
        : { text: 'Fleet attachments are read locally.', pages: 3, scanned: false }
    )
}));

/**
 * What the user hands over, and what the model ends up seeing.
 *
 * Two properties matter more than the rest. Nothing is copied that does not
 * need to be - a file in the working folder stays where it is, so the model
 * sees the version on disk rather than a snapshot of it. And nothing gets in
 * that the tools themselves would refuse: an attachment must not be the way to
 * hand over a `.env`.
 */

const THREAD = '11111111-2222-4333-8444-555555555555';

let dir: string;
let store: AgentImageStore;
let storeRoot: string;

function file(rel: string, contents: string): string {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

const attach = async (source: AgentAttachRequest['source']) =>
  resolveAttachment({ threadId: THREAD, cwd: dir, source }, store);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-attach-'));
  storeRoot = mkdtempSync(join(tmpdir(), 'fleet-attach-store-'));
  store = new AgentImageStore(storeRoot);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(storeRoot, { recursive: true, force: true });
});

describe('pasted, dropped and picked files', () => {
  it('copies an image somewhere durable rather than trusting where it came from', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const result = await attach({
      kind: 'bytes',
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: bytes.buffer
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    if (result.attachment.kind !== 'image') return;
    expect(readdirSync(join(storeRoot, THREAD))).toHaveLength(1);
    expect(readFileSync(result.attachment.path)).toEqual(Buffer.from(bytes));
  });

  it('refuses an image past the ceiling instead of uploading it', async () => {
    const result = await attach({
      kind: 'bytes',
      name: 'huge.png',
      mimeType: 'image/png',
      bytes: new ArrayBuffer(8_000_001)
    });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('too large') });
  });

  it('refuses a kind it cannot do anything with', async () => {
    const result = await attach({
      kind: 'bytes',
      name: 'notes.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new ArrayBuffer(4)
    });

    expect(result.ok).toBe(false);
  });
});

describe('PDFs', () => {
  it('keeps the words and nothing else - not the file they came out of', async () => {
    const result = await attach({
      kind: 'bytes',
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      bytes: new ArrayBuffer(1024)
    });

    if (!result.ok || result.attachment.kind !== 'pdf') throw new Error('not a pdf');
    expect(result.attachment).toEqual({
      kind: 'pdf',
      name: 'notes.pdf',
      text: 'Fleet attachments are read locally.',
      pages: 3,
      scanned: false
    });
    // Nothing about the file survives beyond its words.
    expect(readdirSync(storeRoot)).toHaveLength(0);
  });

  it('carries through that there was nothing in it to read', async () => {
    const result = await attach({
      kind: 'bytes',
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      bytes: new ArrayBuffer(0)
    });

    if (!result.ok || result.attachment.kind !== 'pdf') throw new Error('not a pdf');
    expect(result.attachment.scanned).toBe(true);
  });

  it('refuses one past the ceiling without ever opening it', async () => {
    const result = await attach({
      kind: 'bytes',
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      bytes: new ArrayBuffer(20_000_001)
    });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('too large') });
  });
});

describe('mentions', () => {
  it('points at a file in the folder rather than copying it', async () => {
    const path = file('src/a.ts', 'export const a = 1;\n');

    const result = await attach({ kind: 'path', path });

    if (!result.ok) throw new Error(result.error);
    expect(result.attachment).toEqual({ kind: 'mention', path: realpathSync(path) });
    expect(readdirSync(storeRoot)).toHaveLength(0);
  });

  it('reads an image in the folder in place, so its pixels are never re-encoded', async () => {
    const path = file('docs/shot.png', 'not really a png');

    const result = await attach({ kind: 'path', path });

    if (!result.ok) throw new Error(result.error);
    expect(result.attachment).toEqual({
      kind: 'image',
      path: realpathSync(path),
      mimeType: 'image/png',
      name: 'shot.png'
    });
    expect(readdirSync(storeRoot)).toHaveLength(0);
  });

  // The sandbox is the tools', and mentioning is not a way around it.
  it('refuses a path outside the working folder', async () => {
    const result = await attach({ kind: 'path', path: join(dir, '..', 'elsewhere.ts') });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('outside') });
  });

  it('refuses a file whose name says it holds secrets', async () => {
    const path = file('.env', 'OPENROUTER_API_KEY=sk-live\n');

    const result = await attach({ kind: 'path', path });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('sk-live');
  });
});

describe('what goes on the wire', () => {
  it('puts the words first and the pictures after them', async () => {
    const image = file('shot.png', 'bytes');
    const source = file('a.ts', 'export const a = 1;\n');

    const parts = await attachmentWireParts(
      [
        { kind: 'image', path: realpathSync(image), mimeType: 'image/png', name: 'shot.png' },
        { kind: 'mention', path: realpathSync(source) }
      ],
      { cwd: dir, threadId: THREAD }
    );

    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url']);
    expect(parts[0]).toMatchObject({ text: expect.stringContaining('export const a = 1;') });
    // Named right before it is shown, so a message with several is unambiguous.
    expect(parts[1]).toEqual({ type: 'text', text: 'Image file: shot.png' });
  });

  // Live rather than frozen: the file the user pointed at is the file as it is
  // now, including the edit they made after mentioning it.
  it('re-reads a mentioned file every time, so an edit is what the model sees', async () => {
    const path = realpathSync(file('a.ts', 'first'));
    const ctx = { cwd: dir, threadId: THREAD };

    const before = await attachmentWireParts([{ kind: 'mention', path }], ctx);
    writeFileSync(path, 'second');
    const after = await attachmentWireParts([{ kind: 'mention', path }], ctx);

    expect(before[0]).toMatchObject({ text: expect.stringContaining('first') });
    expect(after[0]).toMatchObject({ text: expect.stringContaining('second') });
  });

  it('says an image is gone rather than failing the turn', async () => {
    const parts = await attachmentWireParts(
      [{ kind: 'image', path: join(dir, 'missing.png'), mimeType: 'image/png', name: 'gone.png' }],
      { cwd: dir, threadId: THREAD }
    );

    expect(parts).toEqual([{ type: 'text', text: expect.stringContaining('could not be read') }]);
  });

  it('says a mentioned file is gone rather than failing the turn', async () => {
    const parts = await attachmentWireParts([{ kind: 'mention', path: join(dir, 'gone.ts') }], {
      cwd: dir,
      threadId: THREAD
    });

    expect(parts[0]).toMatchObject({ text: expect.stringContaining('could not be read') });
  });
});
