import { paneGround } from '../lib/theme';

/**
 * The card a whole-tab tool - settings, sessions, annotate - sits in.
 *
 * These render outside `PaneGrid`, so none of the canvas work reached them:
 * they ran edge to edge with the wallpaper straight through the text and no
 * gutter, radius or lift of any kind. This gives them the same 8px gutter and
 * the same card the panes have.
 *
 * The ground is near-solid rather than the terminals' glass on purpose. A
 * terminal is glanced at and a picture behind it is the point; these three are
 * a settings form, a session list and a screenshot tool, all of them dense text
 * read a line at a time, and a picture moving underneath costs more than it
 * gives. The canvas still shows in the gutter around the card.
 */
export function ToolPaneFrame({
  overCanvas,
  children
}: {
  /** Whether a background image is showing, so the ground knows to go glass. */
  overCanvas: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="h-full w-full p-2">
      <div className="h-full rounded-lg shadow-md shadow-black/20">
        <div
          className="relative flex h-full flex-col overflow-hidden rounded-lg border border-fleet-border"
          style={{ backgroundColor: paneGround('var(--fleet-bg)', overCanvas) }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
