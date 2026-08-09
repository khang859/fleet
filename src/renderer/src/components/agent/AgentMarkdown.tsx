import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { sanitizeMarkdownUrl } from '../../lib/markdown-url';

/** Code highlighting only. Math, mermaid and CJK plugins stay out of the bundle. */
const plugins = { code };

/**
 * Atom One light/dark. The plugin highlights with both and swaps on the `dark:`
 * variant, so switching theme costs no re-highlight.
 *
 * Module-level, and it matters. Streamdown's own memo compares this prop by
 * reference, so an array literal written inline is a new identity on every
 * render of the parent - the top-level gate opens every time and the per-block
 * memoization underneath is never consulted. Passing it inline costs a full
 * remark/rehype and Shiki pass over every finished block on every streamed
 * token, which is most of what a long transcript spends its frame budget on.
 */
const SHIKI_THEME: ['one-light', 'one-dark-pro'] = ['one-light', 'one-dark-pro'];

/**
 * Hoisted for correctness rather than for speed. `controls` is *not* one of the
 * props Streamdown's memo compares, and it reaches the blocks that read it
 * through a context provider - so a value that changed while nothing else did
 * would be held back by the memo and never arrive. A constant cannot change,
 * which is the honest way to say that it never does.
 */
const CONTROLS = { code: { download: false } };

/**
 * Renders one agent reply as Markdown. Streamdown rather than plain
 * react-markdown because a reply arrives a token at a time: it repairs the
 * half-written `**`, backtick or fence at the tip so the text doesn't flash as
 * literal punctuation on the way in, and leaves finished blocks alone instead of
 * re-parsing the whole message on every delta.
 *
 * Memoized because a transcript holds one of these per paragraph of every reply
 * and a streaming turn re-renders its parent on every token. All three props
 * are strings or a boolean, so the default shallow compare is exact: a finished
 * paragraph re-renders when its text changes and at no other time.
 */
export const AgentMarkdown = memo(function AgentMarkdown({
  children,
  streaming,
  className = 'text-sm leading-relaxed'
}: {
  children: string;
  streaming: boolean;
  /** Replaces the type scale, for the smaller muted places a summary appears in. */
  className?: string;
}): React.JSX.Element {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      // Blinking block caret at the live tip, so a slow model still looks alive.
      // The blink and its reduced-motion opt-out live in index.css.
      isAnimating={streaming}
      caret="block"
      plugins={plugins}
      shikiTheme={SHIKI_THEME}
      controls={CONTROLS}
      // Model output is untrusted: only http/https/mailto survive, so a
      // javascript: or file: link can never reach the DOM.
      urlTransform={sanitizeMarkdownUrl}
      className={`fleet-markdown ${className}`}
    >
      {children}
    </Streamdown>
  );
});
