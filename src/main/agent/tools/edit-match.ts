/**
 * Finding the text an edit is about.
 *
 * The whole design question for an edit tool is how forgiving this is, and the
 * field has answered it both ways. opencode runs the model's text through nine
 * increasingly fuzzy matchers ending in a Levenshtein comparison of the middle
 * of a block; Claude Code does none, and requires the text to match exactly.
 *
 * The nine-matcher approach has a documented failure that the strict one cannot
 * have: different matchers find different regions, the ambiguity check only
 * compares exact duplicates, and the edit lands somewhere the model never meant
 * (opencode #1261, #2433). A refused edit costs one round trip. A wrong edit
 * costs a corrupted file that the model then reports as done, and the user
 * finds out later.
 *
 * So: exact first, then one tolerant pass for the single failure that is
 * genuinely the model's formatting rather than its memory - the right lines
 * with the wrong indentation, which is what happens when text is copied out of
 * a numbered read. That pass compares whole lines with their indentation
 * stripped, so it can only ever match the same lines in the same order, and it
 * refuses unless exactly one region matches. Nothing here guesses at content.
 */

export type EditOutcome = {
  text: string;
  /** True when the exact text was not found and indentation was reconciled. */
  reindented: boolean;
};

/**
 * `content` with `oldString` replaced, or a thrown sentence saying why not.
 * Every message here is read by the model and has to say what to do next.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): EditOutcome {
  if (oldString === newString) {
    throw new Error('The old and new text are identical - nothing to change');
  }

  const hits = indexesOf(content, oldString);

  if (hits.length === 1) {
    return { text: splice(content, hits[0], oldString.length, newString), reindented: false };
  }
  if (hits.length > 1) {
    if (!replaceAll) {
      const where = hits.map((at) => lineOf(content, at)).slice(0, 5);
      throw new Error(
        `That text appears ${hits.length} times (line${where.length === 1 ? '' : 's'} ${where.join(', ')}${hits.length > where.length ? ', …' : ''}) - include the lines around the one you mean, or set replaceAll`
      );
    }
    return { text: content.split(oldString).join(newString), reindented: false };
  }

  return { text: byTrimmedLines(content, oldString, newString), reindented: true };
}

/**
 * The same lines, differently indented.
 *
 * The replacement is re-indented by the difference between what the file has
 * and what the model thought it had, so text copied without its leading
 * whitespace does not land flush against the margin.
 */
function byTrimmedLines(content: string, oldString: string, newString: string): string {
  const lines = content.split('\n');
  const needle = oldString.split('\n');
  // Text ending in a newline is about whole lines; the empty tail is not one.
  const trailing = needle.length > 1 && needle[needle.length - 1] === '';
  if (trailing) needle.pop();

  const trimmed = needle.map((line) => line.trim());
  const hits: number[] = [];
  for (let i = 0; i + trimmed.length <= lines.length; i++) {
    if (trimmed.every((want, j) => lines[i + j].trim() === want)) hits.push(i);
  }

  if (hits.length > 1) {
    throw new Error(
      `That text is not in the file exactly as written, and ignoring indentation it matches ${hits.length} places (lines ${hits.map((i) => i + 1).join(', ')}) - copy the lines from the file, indentation included`
    );
  }
  if (hits.length === 0) throw notFound(content, needle);

  const at = hits[0];
  const shift = indentShift(indentOf(lines[at]), indentOf(needle[0]));
  const replacement = newString.split('\n');
  if (trailing && replacement[replacement.length - 1] === '') replacement.pop();

  return [
    ...lines.slice(0, at),
    ...replacement.map(shift),
    ...lines.slice(at + trimmed.length)
  ].join('\n');
}

/**
 * Why the text was not found, in terms the model can act on.
 *
 * "Not found" alone leaves it guessing, which is what makes an agent retry the
 * same edit with a different guess. Naming where its first line actually lives
 * points at the difference without pasting the file back.
 */
function notFound(content: string, needle: string[]): Error {
  const first = needle.find((line) => line.trim() !== '')?.trim();
  if (first === undefined) return new Error('The text to replace is blank');

  const lines = content.split('\n');
  const at = lines
    .map((line, i) => (line.trim() === first ? i + 1 : 0))
    .filter((i) => i !== 0)
    .slice(0, 5);

  if (at.length === 0) {
    return new Error(
      `That text is not in the file, and neither is its first line - read the file again to see what is there now`
    );
  }
  return new Error(
    `That text is not in the file. Its first line is at line${at.length === 1 ? '' : 's'} ${at.join(', ')}, so what follows it differs from what you gave - read that part again and copy it exactly`
  );
}

/** Every start index of `needle` in `haystack`, without regard for regex syntax. */
function indexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

function splice(content: string, at: number, length: number, insert: string): string {
  return content.slice(0, at) + insert + content.slice(at + length);
}

/** 1-indexed line a character offset falls on. */
function lineOf(content: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at; i++) if (content[i] === '\n') line++;
  return line;
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * A function that moves a line from the indentation the model used to the one
 * the file has. Only ever adds or removes whole leading whitespace, and leaves
 * a line alone when the two indents are not related, since guessing further
 * would be reformatting rather than reconciling.
 */
function indentShift(inFile: string, inArgs: string): (line: string) => string {
  if (inFile === inArgs) return (line) => line;
  if (inFile.startsWith(inArgs)) {
    const extra = inFile.slice(inArgs.length);
    return (line) => (line.trim() === '' ? line : extra + line);
  }
  if (inArgs.startsWith(inFile)) {
    const surplus = inArgs.slice(inFile.length);
    return (line) => (line.startsWith(surplus) ? line.slice(surplus.length) : line);
  }
  return (line) => line;
}
