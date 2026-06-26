import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';

/** Feature plugins for chat markdown. Code highlighting only — math/mermaid/cjk
 *  are intentionally omitted to keep the bundle lean. */
const plugins = { code };

type Props = {
  children: string;
  /** Streaming turns get incomplete-markdown repair + the animated caret. */
  streaming?: boolean;
};

/**
 * The chat message markdown renderer. Wraps Streamdown (a streaming-aware
 * react-markdown replacement) so unterminated bold / inline-code / fences don't
 * flash mid-stream and finalized blocks stop re-rendering. Styling flows through
 * the fleet→shadcn token bridge in index.css.
 */
export function ChatMarkdown({ children, streaming = false }: Props): React.JSX.Element {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      plugins={plugins}
      // Dual Atom-One themes (light/dark) — close to the app's prior atom-one-dark
      // highlighting. The code plugin highlights with both and switches via the
      // `dark:` class variant (no re-highlight on theme change); unknown/missing
      // languages fall back to plain text.
      shikiTheme={['one-light', 'one-dark-pro']}
      className="text-sm"
    >
      {children}
    </Streamdown>
  );
}
