import { z } from 'zod';

/**
 * What kind of work a row in the quit warning describes.
 *
 * `pane` rows are built by the renderer, which owns the tab/split tree and so
 * is the only side that can name a pane. The other two are main's alone: a
 * subagent and a background command have no pane of their own to be listed
 * under, and would otherwise be destroyed without ever being mentioned.
 */
export type QuitWorkKind = 'pane' | 'subagent' | 'background';

export type QuitWorkItem = {
  kind: QuitWorkKind;
  id: string;
  label: string;
  /** Only pane rows carry a real state; the rest are simply running. */
  state?: 'working' | 'needs_me';
};

/** What main tells the renderer when it wants a close confirmed. */
export type QuitConfirmAsk = {
  requestId: string;
  /** The live work only main can see. Pane rows are the renderer's to add. */
  items: QuitWorkItem[];
};

/**
 * The renderer's answer, parsed rather than trusted like every other
 * fire-and-forget message from that side.
 */
export const QuitDecideSchema = z.object({
  requestId: z.string().min(1),
  proceed: z.boolean()
});
