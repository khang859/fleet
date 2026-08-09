import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { ZodType } from 'zod';
import { parseDefinitionFile } from './markdown-definitions';

/**
 * Writing one of the markdown-with-frontmatter files the walk beside this reads.
 *
 * Two rules, and the first one is the reason this file exists at all.
 *
 * **The frontmatter is serialized by the YAML library, never by a template
 * literal.** `docs/learnings/2026-04-28-pi-skill-frontmatter-yaml.md` is that
 * mistake already made once: a description containing `": "` produced a file
 * that looked right and would not parse. Hand-building the block is the obvious
 * way to write four lines of YAML and it is wrong for values you did not choose.
 *
 * **What was serialized is parsed back through the reader's own schema before
 * anything touches disk.** This is the guard that makes the first rule hold even
 * when it is broken somewhere else, and it exists because the failure is silent:
 * a file the reader cannot parse is skipped with a `log.warn` nobody sees, so
 * the agent goes on believing it wrote something and the user finds an entry
 * that never appears. Failing here instead turns that into an error the model
 * reads on the call it made.
 *
 * Then a temp file and a `rename`, the way `schedule-store.ts` does it: the
 * rename is the only atomic step and it is last, so a crash midway leaves what
 * was there before rather than half of what is replacing it.
 */
export async function writeFrontmatterFile<F>(
  path: string,
  frontmatter: F,
  body: string,
  schema: ZodType<F>,
  kind: string
): Promise<string> {
  // `stringify` ends with its own newline, and the body is trimmed and given
  // one, so the file reads the way a hand-written one does rather than
  // accumulating blank lines every time it is rewritten.
  const contents = `---\n${stringifyYaml(frontmatter)}---\n\n${body.trim()}\n`;

  const parsed = parseDefinitionFile(contents, schema, kind);
  if (!parsed.ok) {
    throw new Error(
      `Writing that ${kind} produced a file that will not read back - it ${parsed.why}. Nothing was written. Try plainer text, particularly in the description.`
    );
  }

  await mkdir(dirname(path), { recursive: true });
  // The pid is in the name because two Fleet windows can be writing entries in
  // the same folder at the same moment, and a shared temp name would let one
  // rename away the other's half-written file.
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, contents, 'utf8');
    await rename(temp, path);
  } catch (err) {
    // A temp file left behind is litter beside a file the user can see, so it
    // goes even though the write is already failing. Its own failure is not
    // worth reporting over the one that actually happened.
    await unlink(temp).catch(() => undefined);
    throw err;
  }
  return contents;
}
