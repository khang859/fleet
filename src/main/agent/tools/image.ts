import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  OUTPUT_SEPARATOR,
  type AgentToolContext,
  type AgentToolResult,
  type ImageArgs
} from '../../../shared/agent-tools';
import { formatSize } from '../image-kinds';
import { resolveInsideCwd } from './paths';
import type { AgentImageStore } from '../image-store';

/**
 * Make a picture.
 *
 * The one tool here that produces something the user looks at rather than
 * something the model reads back. So the result is written for two readers: the
 * path and the cost go to the model, and the path alone - below the separator -
 * is what the pane draws the image from. The same split `bash` uses, for the
 * same reason: an instruction addressed to the model has no business appearing
 * in the transcript as though it were addressed to the user.
 *
 * Nothing about the image comes back to the model. It cannot see what it made,
 * which is a real limitation and an honest one - the alternative is paying to
 * put every generated picture into the context of every later turn.
 */

/** What a reference may be, when it is not a file in the working folder. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

/**
 * Biggest reference Fleet will upload. A photo is a megabyte; anything far past
 * that is not a reference image, and it travels base64-encoded in a request
 * body that also has to carry the prompt.
 */
const MAX_REFERENCE_BYTES = 8_000_000;

export async function runImage(
  args: ImageArgs,
  ctx: AgentToolContext,
  store: AgentImageStore
): Promise<AgentToolResult> {
  if (ctx.generateImage === null) {
    throw new Error(
      "Image generation is off - no image model is set in Fleet's agent settings. Tell the user that is where to turn it on, and do not try to make the picture another way."
    );
  }

  const references = await Promise.all(
    (args.references ?? []).map(async (ref) => readReference(ref, ctx, store))
  );

  const image = await ctx.generateImage(
    { prompt: args.prompt, references, aspectRatio: args.aspectRatio ?? null },
    ctx.signal
  );

  const path = store.save(ctx.threadId, image.data, image.mimeType);
  const cost = image.costUsd === null ? '' : `, ${formatCost(image.costUsd)}`;
  const what = references.length === 0 ? 'Generated' : 'Edited';

  return {
    text: [
      `${what} an image and saved it to ${path} (${formatSize(image.data.byteLength)}${cost}).`,
      'It is outside the working folder. The user can already see it, so do not describe it back to them; copy it into the project with `bash` only if that is what they asked for.',
      OUTPUT_SEPARATOR,
      path
    ].join('\n'),
    summary: image.costUsd === null ? 'saved' : formatCost(image.costUsd),
    costUsd: image.costUsd
  };
}

/**
 * One reference image, as a data URL.
 *
 * Inlined rather than passed as a path: the endpoint is remote and cannot read
 * this disk, and a path silently produces an image that ignored its reference
 * rather than an error.
 *
 * Two places a reference may live - the working folder, and the store of images
 * this agent generated. Anywhere else is refused, so `references` cannot become
 * a way to read a file the sandbox would not hand over.
 */
async function readReference(
  ref: string,
  ctx: AgentToolContext,
  store: AgentImageStore
): Promise<string> {
  const ext = extname(ref).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`${ref} is not an image - references have to be png, jpg, webp, gif or svg`);
  }

  const own = resolve(ref);
  // A path of ours is taken as given; anything else goes through the working
  // folder's sandbox, which is also what turns a relative path into a real one.
  const abs = store.contains(own) ? own : resolveInsideCwd(ref, ctx.cwd);

  const info = await stat(abs).catch(() => null);
  if (info === null) throw new Error(`${ref} does not exist`);
  if (!info.isFile()) throw new Error(`${ref} is not a file`);
  if (info.size > MAX_REFERENCE_BYTES) {
    throw new Error(`${ref} is ${formatSize(info.size)}, too large to use as a reference`);
  }

  const data = await readFile(abs);
  return `data:${MIME_BY_EXT[ext] ?? 'image/png'};base64,${data.toString('base64')}`;
}

/** Cents matter here: a generation costs a few, and the row is where they show. */
function formatCost(usd: number): string {
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
