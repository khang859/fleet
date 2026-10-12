/**
 * Finding web URLs in a line of terminal text.
 *
 * The hard part is not where a URL starts but where it stops. Programs print
 * URLs inside prose, markdown and brackets, so the characters that follow one -
 * a full stop, a comma, a closing paren - are all legal in a URL and almost
 * never part of it. Matching generously and then cutting back is what keeps
 * `(https://example.com/a).` and `https://en.wikipedia.org/wiki/Foo_(bar)` both
 * right: a closer only belongs to the URL when its opener does too.
 */

export type UrlMatch = {
  text: string;
  /** Offset of the URL in the line it was found in. */
  index: number;
};

/**
 * Whitespace, quotes and angle brackets never appear raw in a printed URL, so
 * they end it outright. Box-drawing characters end it too, which is what keeps
 * the border of a TUI panel out of a URL that runs up against it.
 */
const URL_SOURCE = /https?:\/\/[^\s"'<>`‘’“”─-╿]+/.source;

const OPENER_FOR: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Sentence punctuation and markdown emphasis stripped from the right. `=`, `-`
 * and `_` are absent on purpose: base64 padding and the last character of a JWT
 * signature are exactly those, and losing one breaks the token.
 */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '*', '…']);

/** Cut at the first closing bracket whose opener is not inside the URL. */
function cutAtUnbalancedCloser(text: string): string {
  const depth: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch in depth) {
      depth[ch]++;
    } else if (ch in OPENER_FOR) {
      if (depth[OPENER_FOR[ch]] === 0) return text.slice(0, i);
      depth[OPENER_FOR[ch]]--;
    }
  }
  return text;
}

function stripTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING.has(text[end - 1])) end--;
  return text.slice(0, end);
}

function hasHost(text: string): boolean {
  try {
    return new URL(text).hostname !== '';
  } catch {
    return false;
  }
}

export function findUrls(lineText: string): UrlMatch[] {
  const re = new RegExp(URL_SOURCE, 'gi');
  const matches: UrlMatch[] = [];

  for (let match = re.exec(lineText); match; match = re.exec(lineText)) {
    const text = stripTrailingPunctuation(cutAtUnbalancedCloser(match[0]));
    // Scanning resumes right after what was kept, so the second URL of
    // `[https://a.example](https://b.example)` is still found.
    re.lastIndex = match.index + Math.max(text.length, 1);
    if (hasHost(text)) matches.push({ text, index: match.index });
  }

  return matches;
}
