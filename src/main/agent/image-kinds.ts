import { extname } from 'node:path';

/**
 * The picture formats Fleet will put in front of a model.
 *
 * Exactly what OpenRouter's chat completions accept, which is why svg is not
 * here: it is XML rather than pixels, no provider decodes it as an image, and
 * reading it as text - which is what happens instead - is more use to a model
 * than a render of it would be.
 *
 * Kept apart from the image *tool's* own list, which includes svg because a
 * reference image is uploaded to an image endpoint rather than to a model.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

/** The type of a picture at this path, or `null` when it is not one of ours. */
export function imageMimeFor(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

/** Whether a picture of this type is one a model will be shown. */
export function isSendableImage(mimeType: string): boolean {
  return Object.values(MIME_BY_EXT).includes(mimeType.toLowerCase());
}

/** Bytes as something an `<img>` or a completions request can load. */
export function toDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** A size for a one-line summary, in the units a person reads it in. */
export function formatSize(bytes: number): string {
  return bytes < 1_000_000
    ? `${Math.round(bytes / 1000)} KB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
}
