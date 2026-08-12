import type {
  DeepPartial,
  TerminalBackground,
  TerminalBackgroundSlideshow
} from '../../../shared/types';
import { useSettingsStore } from '../store/settings-store';
import { useToastStore } from '../store/toast-store';

/**
 * Turning a picture into the window's background, from wherever it is shown.
 *
 * The rules live here rather than in the settings pane because they are not
 * settings-pane rules: a background is one global thing, and every place that
 * can hand it a picture - the settings pane, an image in the agent's transcript
 * - has to agree on what "use this one" means. What each rule decides is a pure
 * function of what is already stored, so it can be tested without a store, an
 * app, or a disk; the exported actions around them do the talking.
 */

/**
 * Show this picture, and only this picture.
 *
 * The slideshow goes off as well as the path going on. `imagePath` and the
 * slideshow are not alternatives the renderer picks between - the slideshow
 * wins whenever it is enabled (see `resolveBackgroundSrc`), so setting the path
 * while a show is running would change a setting and nothing else, and the user
 * would have asked for a picture and watched the old one carry on.
 */
export function backgroundImagePatch(path: string): DeepPartial<TerminalBackground> {
  return { imagePath: path, slideshow: { enabled: false } };
}

/**
 * The file list a slideshow should hold after adding some pictures to it.
 *
 * `folderImages` is what the configured folder currently holds, passed in
 * rather than scanned here so this stays a decision rather than an effect. It
 * matters only when the show is running off a folder: appending to `filePaths`
 * would add the picture to a list nothing is reading, because a folder show
 * never looks at one. So the folder's contents seed the list before the new
 * picture goes on the end, and the show the user is watching carries on with
 * one more image in it instead of collapsing to the single one they just added.
 *
 * The folder is frozen at that moment, which is the honest trade: a list and a
 * folder cannot both be the source, and dropping fifty images to honour one is
 * the worse half of it.
 *
 * Says nothing about `enabled`. Adding to a show that is already running must
 * not claim to have started it, and the settings pane's own file picker is only
 * reachable from a show that is on.
 */
export function nextSlideshowFiles(
  slideshow: TerminalBackgroundSlideshow,
  newPaths: string[],
  folderImages: string[] = []
): { source: 'files'; filePaths: string[] } {
  const base = slideshow.source === 'folder' ? folderImages : slideshow.filePaths;
  const filePaths = [...base];
  for (const path of newPaths) if (!filePaths.includes(path)) filePaths.push(path);
  return { source: 'files', filePaths };
}

/**
 * Save the picture somewhere permanent first, then point a setting at it.
 *
 * Every caller here is holding a path to a file it does not own - an image the
 * agent drew lives under the conversation that made it and is deleted with it -
 * so the copy is what makes a background a background rather than a path that
 * works until the user tidies up.
 */
async function adopt(path: string): Promise<string | null> {
  const result = await window.fleet.background.adopt(path);
  if (!result.success) {
    useToastStore.getState().show(result.error);
    return null;
  }
  return result.path;
}

/** Read the background as it is right now, not as it was when a component rendered. */
function currentBackground(): TerminalBackground | null {
  return useSettingsStore.getState().settings?.general.terminalBackground ?? null;
}

/** Use this picture as the window background. */
export async function setAsBackground(path: string): Promise<void> {
  const adopted = await adopt(path);
  if (adopted === null) return;
  await useSettingsStore
    .getState()
    .updateSettings({ general: { terminalBackground: backgroundImagePatch(adopted) } });
  useToastStore.getState().show('Set as background');
}

/**
 * The tail of the queue every slideshow change waits behind.
 *
 * Adding a picture is a read-modify-write across two round trips - adopt the
 * file, then read the list, then write it back - and the settings store
 * replaces `filePaths` wholesale rather than merging it. So two pictures added
 * in the same second would both read the list as it was before either landed,
 * and the second write would drop the first picture with no sign it had gone.
 * That is not a rare interleaving here: it is what adding two images from one
 * transcript looks like, now that it takes a click rather than a file dialog.
 */
let slideshowQueue: Promise<void> = Promise.resolve();

/** Add this picture to the background slideshow, turning it on if it was off. */
export async function addToSlideshow(path: string): Promise<void> {
  // Both statements run before this function first suspends, so two clicks in
  // the same tick still queue in the order they arrived.
  const task = slideshowQueue.then(async () => addToSlideshowNow(path));
  // The queue tracks a settled promise, so one failed add cannot wedge every
  // add after it - the caller still sees the rejection through `task`.
  slideshowQueue = task.catch(() => undefined);
  return task;
}

async function addToSlideshowNow(path: string): Promise<void> {
  const adopted = await adopt(path);
  if (adopted === null) return;

  // Scanned before the read-modify-write below rather than inside it, so the
  // settings the patch is built from are the ones read after every await.
  const before = currentBackground();
  const folderImages =
    before?.slideshow.source === 'folder' && before.slideshow.folderPath !== ''
      ? await window.fleet.file.scanImageFolder(before.slideshow.folderPath)
      : [];

  const background = currentBackground();
  if (background === null) return;
  const next = nextSlideshowFiles(background.slideshow, [adopted], folderImages);
  await useSettingsStore.getState().updateSettings({
    general: { terminalBackground: { slideshow: { ...next, enabled: true } } }
  });

  useToastStore.getState().show(`Added to slideshow (${next.filePaths.length} images)`);
}
