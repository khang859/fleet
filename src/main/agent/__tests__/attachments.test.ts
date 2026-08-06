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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentWireParts, resolveAttachment } from '../attachments';
import { AgentImageStore } from '../image-store';
import type { AgentAttachRequest } from '../../../shared/agent-types';

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

/**
 * A real PDF, written out by hand.
 *
 * Built here rather than checked in as bytes or produced by whatever converter
 * the machine happens to have: this has to run the same on a laptop and on CI,
 * and a fixture whose contents nobody can read is a fixture nobody can change.
 * It is the smallest document pdfjs will accept - a catalog, one page, one font
 * and a content stream - with the byte offsets in the cross-reference table
 * counted as it is assembled.
 */
function pdfWith(lines: string[]): ArrayBuffer {
  const content =
    lines.length === 0
      ? ''
      : `BT /F1 12 Tf 72 720 Td 14 TL\n${lines.map((l) => `(${l}) Tj T*`).join('\n')}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) pdf += `${String(at).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer;
}

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
  it('reads the words out once, on this machine, rather than sending the file', async () => {
    const bytes = pdfWith(['Fleet attachments are read locally.']);

    const result = await attach({
      kind: 'bytes',
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      bytes
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.attachment.kind !== 'pdf') throw new Error('not a pdf');
    expect(result.attachment.text).toContain('Fleet attachments are read locally.');
    expect(result.attachment.pages).toBe(1);
    expect(result.attachment.scanned).toBe(false);
    // Nothing about the file survives beyond its words.
    expect(readdirSync(storeRoot)).toHaveLength(0);
  });

  it('says so when there is no text in it at all', async () => {
    const bytes = pdfWith([]);

    const result = await attach({
      kind: 'bytes',
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      bytes
    });

    if (!result.ok || result.attachment.kind !== 'pdf') throw new Error('not a pdf');
    expect(result.attachment.scanned).toBe(true);
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
