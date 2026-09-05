import { toFleetImageUrl } from '../../../shared/path-platform';
import { useToastStore } from '../store/toast-store';

/**
 * Taking a generated picture out of Fleet.
 *
 * A picture the agent drew lives under the conversation that made it and is
 * deleted with it, so every one of these is the difference between keeping the
 * thing and losing it. They sit here rather than in the component because the
 * hover bar and the opened viewer both offer them, and an action that reports
 * failure two different ways depending on which copy of the button was clicked
 * is two actions.
 *
 * Main answers with a result rather than throwing, so the only thing left to
 * decide here is what the user is told - and the rule is that a refusal is
 * always said out loud and a success mostly is not. Revealing a file puts a
 * file manager in front of the user, which is its own confirmation; saving and
 * copying leave the app looking exactly as it did, so those say so.
 */

function report(result: { success: boolean; error?: string }, done: string | null): void {
  if (!result.success) {
    useToastStore.getState().show(result.error ?? 'That did not work');
    return;
  }
  if (done !== null) useToastStore.getState().show(done);
}

/** Ask where to put a copy of this picture, then put one there. */
export async function saveImageAs(path: string): Promise<void> {
  const result = await window.fleet.agent.image.saveAs(path, suggestedName(path));
  // A cancelled dialog succeeds with nothing saved. The user closed it on
  // purpose, so telling them it did not save would be answering a question
  // nobody asked.
  if (result.success && result.path === undefined) return;
  report(result, 'Image saved');
}

/** Open the file manager with this picture selected. */
export async function revealImage(path: string): Promise<void> {
  report(await window.fleet.agent.image.reveal(path), null);
}

/**
 * Put the picture itself - not its path - on the clipboard.
 *
 * Done here rather than in main, which is where the other three live, because
 * this one needs a decoder rather than the disk: Electron's `nativeImage` reads
 * PNG and JPEG and nothing else, so a generated WebP - which is most of them -
 * would come back empty. The renderer has the whole of Chromium's decoding, and
 * reaches the file through the same `fleet-image` protocol that drew it on
 * screen a moment ago, so this asks for nothing it did not already have.
 *
 * Written as a PNG whatever it came in as, because that is the format every
 * other application expects to find on the clipboard.
 */
export async function copyImageToClipboard(path: string): Promise<void> {
  try {
    const png = await toPng(path);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    useToastStore.getState().show('Image copied');
  } catch {
    // An SVG is the one thing that lands here: it has no intrinsic size, so
    // Chromium will not make a bitmap of it. Saying so beats leaving an empty
    // clipboard in front of someone who pastes nothing and wonders which end
    // broke.
    useToastStore.getState().show('That image cannot be copied as pixels');
  }
}

/**
 * The picture, decoded by Chromium and re-encoded as a PNG.
 *
 * `longestSide` shrinks it on the way, for the one caller that wants a
 * thumbnail rather than the picture.
 */
async function toPng(path: string, longestSide?: number): Promise<Blob> {
  const response = await fetch(toFleetImageUrl(path));
  const bitmap = await createImageBitmap(await response.blob());
  const scale =
    longestSide === undefined
      ? 1
      : Math.min(1, longestSide / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale))
  );
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** How big the picture under the cursor is while it is being dragged. */
const DRAG_ICON_PX = 96;

/**
 * Hand the drag to the OS.
 *
 * Not reported: once main calls `startDrag` the gesture belongs to the window
 * manager, and there is nothing to wait for and nothing to say. A drag that main
 * refuses simply does not start, which is what every failed drag looks like
 * anyway.
 *
 * The thumbnail that travels under the cursor is made here rather than in main,
 * for the reason the clipboard copy is: `startDrag` throws on an empty icon
 * rather than dragging without one, and `nativeImage` decodes PNG and JPEG and
 * nothing else - so a generated WebP would produce no icon and therefore no
 * drag at all. Chromium has already decoded this exact file to draw it on
 * screen. Bytes rather than a data URL: they cross the boundary as they are,
 * with no base64 in between. If the encode fails main still tries the file
 * itself, which is right for the formats it can read.
 */
export async function startImageDrag(path: string): Promise<void> {
  let icon: Uint8Array | undefined;
  try {
    icon = new Uint8Array(await (await toPng(path, DRAG_ICON_PX)).arrayBuffer());
  } catch {
    // No icon from here; main falls back to reading the file.
  }
  window.fleet.agent.image.startDrag(path, icon);
}

/**
 * What the save dialog should offer as a filename.
 *
 * The stored basename, which is a uuid plus an extension - unlovely, but it is
 * the extension that matters: the dialog uses it to pick the format, and a
 * suggestion without one saves a PNG called `image` that nothing will open by
 * double-clicking. The user renames it in the dialog either way.
 */
function suggestedName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'image.png';
}
