import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  ATTACHMENT_MAX_IMAGE_BYTES,
  ATTACHMENT_MAX_PDF_BYTES,
  type AgentAttachRequest,
  type AgentAttachResult,
  type AgentAttachment
} from '../../shared/agent-types';
import type { AgentToolContext, AgentToolImage } from '../../shared/agent-tools';
import type { WireContentPart } from './openrouter';
import { isAgentImagePath, type AgentImageStore } from './image-store';
import { formatSize, imageMimeFor, isSendableImage, toDataUrl } from './image-kinds';
import { parsePdf } from './pdf/parse';
import { displayPath, resolveInsideCwd } from './tools/paths';
import { runRead } from './tools/read';
import { createLogger } from '../logger';

const log = createLogger('agent:attachments');

/**
 * What the user hands the agent along with a message, from the gesture that
 * produced it to the bytes that go on the wire.
 *
 * Two rules shape the whole file. Nothing is stored as bytes - an image is a
 * path, read again each time the turn is built - so a conversation with a
 * screenshot in it stays a log rather than becoming a store of base64, and the
 * model always sees the file as it is now. And nothing here invents its own
 * idea of what may be read: a mention goes through the same sandbox every tool
 * does, so an attachment cannot become the way to hand over a `.env`.
 *
 * A PDF is the one thing that is not re-read. Its text is pulled out once, with
 * pdfjs, on the machine - which is why a PDF costs nothing to attach, works on
 * a model that cannot see pictures at all, and is never parsed twice.
 */

const PDF_MIME = 'application/pdf';

/** One source, resolved into something a message can carry. */
export async function resolveAttachment(
  req: AgentAttachRequest,
  store: AgentImageStore
): Promise<AgentAttachResult> {
  try {
    return { ok: true, attachment: await resolve(req, store) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.debug('attach refused', { error });
    return { ok: false, error };
  }
}

async function resolve(req: AgentAttachRequest, store: AgentImageStore): Promise<AgentAttachment> {
  if (req.source.kind === 'bytes') {
    const { name, mimeType } = req.source;
    const bytes = new Uint8Array(req.source.bytes);

    if (mimeType === PDF_MIME) {
      if (bytes.byteLength > ATTACHMENT_MAX_PDF_BYTES) {
        throw new Error(`${name} is ${formatSize(bytes.byteLength)}, too large to read`);
      }
      return readPdf(name, bytes);
    }

    if (!isSendableImage(mimeType)) {
      throw new Error(`${name} is not something the agent can look at`);
    }
    if (bytes.byteLength > ATTACHMENT_MAX_IMAGE_BYTES) {
      throw new Error(`${name} is ${formatSize(bytes.byteLength)}, too large to attach`);
    }
    // Copied into Fleet's own folder rather than left where it came from: a
    // pasted screenshot has no file at all, and one dragged out of Downloads
    // may not be there tomorrow. What is attached has to outlive the gesture.
    return { kind: 'image', path: store.save(req.threadId, bytes, mimeType), mimeType, name };
  }

  // A mention. The working folder's sandbox is what decides whether this file
  // may be read at all, and it is also what turns the path into a real one.
  const abs = resolveInsideCwd(req.source.path, req.cwd);
  const info = await stat(abs).catch(() => null);
  const shown = displayPath(abs, req.cwd);
  if (info === null) throw new Error(`${shown} does not exist`);
  if (!info.isFile()) throw new Error(`${shown} is not a file`);

  if (extname(abs).toLowerCase() === '.pdf') {
    if (info.size > ATTACHMENT_MAX_PDF_BYTES) {
      throw new Error(`${shown} is ${formatSize(info.size)}, too large to read`);
    }
    return readPdf(basename(abs), new Uint8Array(await readFile(abs)));
  }

  const mimeType = imageMimeFor(abs);
  if (mimeType !== null) {
    if (info.size > ATTACHMENT_MAX_IMAGE_BYTES) {
      throw new Error(`${shown} is ${formatSize(info.size)}, too large to attach`);
    }
    // Deliberately not copied. It is a file in the project the user is working
    // on, so the one they mean is the one on disk, however it changes.
    return { kind: 'image', path: abs, mimeType, name: basename(abs) };
  }

  return { kind: 'mention', path: abs };
}

/** A PDF, as words. The reading itself happens off this thread - see `./pdf/parse`. */
async function readPdf(name: string, bytes: Uint8Array): Promise<AgentAttachment> {
  return { kind: 'pdf', name, ...(await parsePdf(bytes)) };
}

/**
 * What one turn's attachments look like on the wire.
 *
 * Text first and pictures last, which is the order OpenRouter asks for, and
 * every picture is introduced by its own name on the line above it - otherwise
 * a message with three images in it gives the model no way to say which one it
 * is talking about.
 */
export async function attachmentWireParts(
  attachments: AgentAttachment[],
  ctx: { cwd: string; threadId: string }
): Promise<WireContentPart[]> {
  const parts: WireContentPart[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'pdf') parts.push({ type: 'text', text: pdfText(attachment) });
    if (attachment.kind === 'mention') {
      parts.push({ type: 'text', text: await mentionText(attachment.path, ctx) });
    }
  }
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue;
    parts.push(...(await imageWireParts(attachment, attachment.name, ctx.cwd)));
  }
  return parts;
}

/** One picture, named and then shown. */
export async function imageWireParts(
  image: AgentToolImage,
  label: string,
  cwd: string
): Promise<WireContentPart[]> {
  const bytes = await imageBytes(image.path, cwd);
  // A turn is not worth failing over a file that moved. The model is told what
  // it cannot see, which is better than an image it is never told about.
  if (bytes === null) {
    log.warn('image no longer readable', { path: image.path });
    return [
      {
        type: 'text',
        text: `Image file ${label} could not be read - it may have been moved or deleted.`
      }
    ];
  }
  return [
    { type: 'text', text: `Image file: ${label}` },
    { type: 'image_url', image_url: { url: toDataUrl(bytes, image.mimeType) } }
  ];
}

/**
 * The bytes of a picture that is still allowed to be sent, or `null`.
 *
 * Checked again here, on every turn, rather than trusted from when the file was
 * attached - which is the only place it *can* be checked, because a picture in
 * the working folder is deliberately not copied. What sits at that path can
 * change: a symlink dropped in its place points somewhere the tools would
 * refuse, and a file that was small enough yesterday is not a promise about the
 * file today.
 *
 * Fleet's own picture folders are the exception, and the reason they exist: a
 * pasted screenshot and an image the agent drew have no home in the project, so
 * the working folder is the wrong question to ask about them.
 */
async function imageBytes(path: string, cwd: string): Promise<Uint8Array | null> {
  try {
    if (!isAgentImagePath(path)) resolveInsideCwd(path, cwd);
    const info = await stat(path);
    if (!info.isFile() || info.size > ATTACHMENT_MAX_IMAGE_BYTES) return null;
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function pdfText(attachment: AgentAttachment & { kind: 'pdf' }): string {
  const { name, pages, text, scanned } = attachment;
  const count = `${pages} page${pages === 1 ? '' : 's'}`;
  if (scanned) {
    return `Attached file: ${name} (${count}). It has no text in it - it is a scan or a set of images - so there is nothing to read out of it.`;
  }
  return `Attached file: ${name} (${count}):\n\n${text}`;
}

/**
 * A mentioned file, as the model sees it.
 *
 * Read through `read` itself rather than through a copy of it: the numbering,
 * the line-length clipping and the "… more lines below, read on with offset=N"
 * footer are all things the model already knows how to act on, and a second
 * implementation of them would be a second set of edge cases to keep in step.
 *
 * Called as a plain function, so this is not a tool call and never pretends to
 * be one. Nothing in the transcript claims the agent went and fetched this -
 * the user pointed at it, and it arrives in their own message.
 */
async function mentionText(path: string, ctx: { cwd: string; threadId: string }): Promise<string> {
  const shown = displayPath(path, ctx.cwd);
  try {
    const result = await runRead({ path }, readOnlyContext(ctx));
    return `Mentioned file: ${shown}\n\n${result.text}`;
  } catch (err) {
    // A file deleted since it was mentioned, or one the sandbox now refuses.
    // Said plainly, because the alternative is a turn that fails on history.
    const message = err instanceof Error ? err.message : String(err);
    return `Mentioned file: ${shown} could not be read - ${message}`;
  }
}

/**
 * A tool context for a call nothing made.
 *
 * `read` takes one because every tool does, but it uses only the folder and the
 * conversation. The rest is filled with the answer that grants nothing: there
 * is no turn to abort, no user to ask, and nothing here may run a command.
 */
function readOnlyContext(ctx: { cwd: string; threadId: string }): AgentToolContext {
  return {
    cwd: ctx.cwd,
    threadId: ctx.threadId,
    signal: new AbortController().signal,
    handOff: () => {},
    approve: async () => Promise.resolve(false),
    wasRefused: () => false,
    generateImage: null,
    mcp: null,
    dispatchTask: null,
    findSubagent: null,
    todos: { list: () => [], save: () => {} }
  };
}
