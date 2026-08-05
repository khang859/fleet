import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { sanitizeMarkdownUrl } from '../../lib/markdown-url';

/** Code highlighting only. Math, mermaid and CJK plugins stay out of the bundle. */
const plugins = { code };

/**
 * Renders one agent reply as Markdown. Streamdown rather than plain
 * react-markdown because a reply arrives a token at a time: it repairs the
 * half-written `**`, backtick or fence at the tip so the text doesn't flash as
 * literal punctuation on the way in, and leaves finished blocks alone instead of
 * re-parsing the whole message on every delta.
 */
export function AgentMarkdown({
  children,
  streaming
}: {
  children: string;
  streaming: boolean;
}): React.JSX.Element {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      // Blinking block caret at the live tip, so a slow model still looks alive.
      // The blink and its reduced-motion opt-out live in index.css.
      isAnimating={streaming}
      caret="block"
      plugins={plugins}
      // Atom One light/dark. The plugin highlights with both and swaps on the
      // `dark:` variant, so switching theme costs no re-highlight.
      shikiTheme={['one-light', 'one-dark-pro']}
      controls={{ code: { download: false } }}
      // Model output is untrusted: only http/https/mailto survive, so a
      // javascript: or file: link can never reach the DOM.
      urlTransform={sanitizeMarkdownUrl}
      className="fleet-markdown text-sm leading-relaxed"
    >
      {children}
    </Streamdown>
  );
}
