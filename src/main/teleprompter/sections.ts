/** An opening or closing code fence: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const SEPARATOR = /^ {0,3}---\s*$/;
/** The first line of YAML front matter is a `key: value` pair. */
const YAML_KEY = /^[\w-]+\s*:/;

/**
 * Where the notes start once any YAML front matter is skipped.
 *
 * A leading `---` is only front matter when a closing line follows and the
 * block opens with a `key:` line. Otherwise notes that simply begin with a
 * separator would lose their whole first section.
 */
function bodyStart(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const firstContent = lines.slice(1).find((line) => line.trim() !== '');
  if (firstContent === undefined || !YAML_KEY.test(firstContent)) return 0;
  const close = lines.findIndex(
    (line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...')
  );
  return close > 0 ? close + 1 : 0;
}

/**
 * Split presenter notes into sections on `---` lines.
 *
 * A `---` inside a fenced code block is content, not a separator. Blank
 * sections, from back-to-back separators or a trailing one, are dropped so
 * navigation never lands on an empty card.
 *
 * `Title` followed by `---` is a setext heading in CommonMark, but here it is
 * a separator: in a notes file written for this, that is what the author means.
 */
export function splitSections(markdown: string): string[] {
  const lines = markdown
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const sections: string[] = [];
  let buffer: string[] = [];
  let fence: { char: string; length: number } | null = null;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text) sections.push(text);
    buffer = [];
  };

  for (const line of lines.slice(bodyStart(lines))) {
    if (fence) {
      const close = CLOSING_FENCE.exec(line);
      if (close?.[1].startsWith(fence.char) && close[1].length >= fence.length) fence = null;
    } else {
      const open = FENCE.exec(line);
      if (open) {
        fence = { char: open[1][0], length: open[1].length };
      } else if (SEPARATOR.test(line)) {
        flush();
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return sections;
}
