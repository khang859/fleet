import { z } from 'zod';

/**
 * Reaching into one pane's composer from elsewhere in the same pane.
 *
 * Through the document rather than through props, because the composer owns
 * both its text and the attachments it is holding, and neither the empty
 * state's chips nor the gallery tab is its parent - they are its siblings, two
 * and three levels up. The same pattern, and the same zod guard, that
 * `fleet:refocus-pane` uses to reach into one pane from anywhere else in the
 * app.
 *
 * Every event is scoped by pane id, because every open agent pane has a
 * composer listening and only one of them was clicked.
 *
 * In their own module rather than beside the composer so that the file holding
 * the components stays a file of components, which is what lets fast refresh
 * swap it without remounting the pane.
 */

/** The event a chip in the empty state fires. */
export const PrefillDetail = z.object({ paneId: z.string(), text: z.string() });

/** The event the gallery fires when a picture is to go back into a message. */
export const AttachDetail = z.object({ paneId: z.string(), path: z.string() });

/** Put text in this pane's composer. */
export function prefillComposer(paneId: string, text: string): void {
  document.dispatchEvent(new CustomEvent('fleet:agent-prefill', { detail: { paneId, text } }));
}

/** Attach a file to this pane's composer. */
export function attachToComposer(paneId: string, path: string): void {
  document.dispatchEvent(new CustomEvent('fleet:agent-attach', { detail: { paneId, path } }));
}
