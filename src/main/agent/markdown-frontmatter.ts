/**
 * The `---` block at the top of a definition file, and everything after it.
 *
 * Hand-rolled rather than a library because the format is one rule - the file
 * opens with a fence, and the next fence on a line of its own closes it - and
 * every frontmatter library is a YAML parser with this wrapped around it, which
 * we already have. A leading BOM is stripped because an editor on Windows will
 * put one there and it makes the first fence stop being the first thing.
 *
 * Here rather than beside the subagents that first needed it, because commands
 * are the second thing on disk with a fence at the top and the two must read
 * the same file the same way. The rules below are the fiddly part - a `----`
 * rule and a `---` inside a block scalar both look like a closing fence - and a
 * second hand-rolled copy would get one of them wrong eventually.
 */
export function splitFrontmatter(contents: string): { frontmatter: string; body: string } | null {
  const text = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;

  // The closing fence has to be a whole line of its own. Searching for `\n---`
  // and taking the first hit would end the block early on a `----` rule or a
  // `---` inside a YAML block scalar, so a candidate that turns out to have
  // something after it on its line is skipped rather than fatal.
  for (let at = text.indexOf('\n---', 3); at !== -1; at = text.indexOf('\n---', at + 1)) {
    const after = text.slice(at + 4);
    if (after !== '' && !after.startsWith('\n')) continue;
    return { frontmatter: text.slice(4, at), body: after };
  }
  return null;
}
