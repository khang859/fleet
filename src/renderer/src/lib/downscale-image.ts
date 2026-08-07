/**
 * A picture cut down to something worth sending.
 *
 * A screenshot off a retina display is 5120 pixels wide, and no model looks at
 * it that way - every provider scales it down at the other end, so sending the
 * original buys nothing and costs the upload. Cut here instead, where there is
 * already a canvas.
 *
 * Only what Fleet is about to copy anyway - a paste, a drop, a file picked. A
 * file in the working folder is left exactly as it is: the user pointing at an
 * image in their own project may be pointing at the pixels.
 */

/** Longest edge Fleet will send. Past this is detail no provider keeps. */
const MAX_EDGE = 2048;

export type DownscaledImage = { bytes: ArrayBuffer; mimeType: string };

export async function downscaleImage(file: File): Promise<DownscaledImage> {
  const original: DownscaledImage = { bytes: await file.arrayBuffer(), mimeType: file.type };
  // A gif re-drawn to a canvas is its first frame, which is not the picture the
  // user attached. Better to send an animation whole than a still of it.
  if (file.type === 'image/gif') return original;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = MAX_EDGE / Math.max(bitmap.width, bitmap.height);
    // Never enlarged. An icon blown up to 2048 is the same icon and eight
    // times the bytes.
    if (scale >= 1) {
      bitmap.close();
      return original;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (context === null) return original;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    // Kept as png unless it was already a jpeg: re-encoding a screenshot as
    // jpeg puts artefacts around exactly the thing being looked at, which is
    // text more often than not.
    const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, mimeType, 0.92));
    if (blob === null) return original;
    return { bytes: await blob.arrayBuffer(), mimeType };
  } catch {
    // A format the browser cannot decode is still a format a provider might.
    return original;
  }
}
