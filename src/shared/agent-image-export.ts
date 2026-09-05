/**
 * What an export action answers with.
 *
 * A result rather than a thrown error, the way attachments and background
 * adoption already answer: a cancelled save dialog and a file that would not
 * copy are both ordinary outcomes of asking, and neither is worth an exception
 * crossing the IPC boundary.
 *
 * A success with no `path` is the cancel: nothing went wrong and nothing was
 * written, so there is nothing to tell the user.
 */
export type ImageActionResult =
  | { success: true; path?: string }
  | { success: false; error: string };
