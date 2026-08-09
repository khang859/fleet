import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_LISTED_FILES,
  renderSkill,
  type SkillArgsFields,
  type SkillDefinition
} from '../../../shared/agent-skills';
import type { AgentToolContext, AgentToolResult } from '../../../shared/agent-tools';
import { remember } from './freshness';
import { realpathOrNearest, resolveInsideCwd } from './paths';

/**
 * Loading a skill's instructions, and the files it bundles.
 *
 * Two jobs in one tool because they share a root. The instructions are cheap and
 * already read; the files are the reason this tool has to serve them at all,
 * since every other path tool is confined to the working folder and a skill is
 * not in it.
 *
 * No caching and no "already loaded" check. A model that asks twice is a model
 * that lost the thread and is asking to be reminded, and answering the second
 * call with a note saying it has this already is answering a question it did
 * not ask. The body is small and the file is already in the page cache.
 */
export async function runSkill(
  args: SkillArgsFields,
  ctx: AgentToolContext
): Promise<AgentToolResult> {
  if (ctx.findSkill === null) {
    throw new Error('There are no skills in this folder.');
  }

  const definition = ctx.findSkill(args.name);
  if (definition === null) {
    // The name it asked for rather than a list of the ones there are: the enum
    // in the tool schema already carries the list, so a model that got here
    // typed something outside it, and repeating the enum back is repeating what
    // it has been sent every round of this turn.
    throw new Error(`There is no skill called "${args.name}".`);
  }

  if (args.file !== undefined && args.file !== '') {
    return bundledFile(definition, args.file);
  }

  // Loading a skill counts as having read its `SKILL.md`, which is what lets
  // `/refine` correct one in the same conversation it noticed the problem in.
  // Without it, `skill_write` would refuse the only sequence that makes sense -
  // read the procedure, see what it got wrong, rewrite it - and tell the model
  // to go and read something it is holding.
  //
  // Under the real path, because that is the form the write path stamps against.
  const entry = realpathOrNearest(join(definition.dir, 'SKILL.md'));
  const stamp = await stat(entry).catch(() => null);
  if (stamp !== null) remember(ctx.threadId, entry, stamp);

  const text = renderSkill(definition, await listFiles(definition.dir));
  return { text, summary: countLines(text) };
}

/**
 * How much came back, which is what the right-hand end of a transcript row says
 * for every other tool. The name of the skill is not a summary of the call -
 * it is what the call was about, and it belongs next to the verb.
 */
function countLines(text: string): string {
  const lines = text.split('\n').length;
  return `${lines} line${lines === 1 ? '' : 's'}`;
}

/**
 * One file from inside a skill.
 *
 * `resolveInsideCwd` with the skill's folder as the root rather than the pane's.
 * It is the same question asked about a different root - is this path really
 * under that folder once symlinks are resolved - and it carries the credential
 * and `.env` denials along with it, which a skill folder deserves as much as a
 * repo does.
 */
async function bundledFile(
  definition: SkillDefinition,
  requested: string
): Promise<AgentToolResult> {
  let path: string;
  try {
    path = resolveInsideCwd(requested, definition.dir);
  } catch {
    // Reworded, because the tool's own message says "the working folder" and
    // this root is not that. A model told the wrong thing here would go looking
    // for a sandbox problem it does not have.
    throw new Error(`${requested} is not inside the ${definition.name} skill.`);
  }

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(
      `The ${definition.name} skill has no file at ${requested}. Load the skill without \`file\` to see what it does have.`
    );
  }
  if (size > SKILL_MAX_FILE_BYTES) {
    throw new Error(
      `${requested} is ${Math.round(size / 1000)}kB, too large to load in one piece.`
    );
  }

  const text = await readFile(path, 'utf8');
  return {
    text: `${requested}, from the "${definition.name}" skill:\n\n${text}`,
    summary: countLines(text)
  };
}

/**
 * What the skill bundles, as paths relative to it.
 *
 * A walk rather than one `readdir`, because the format nests by convention -
 * `scripts/`, `references/`, `assets/` - and a listing that stopped at the top
 * level would show three folder names and nothing worth asking for.
 *
 * Capped, and the cap is silent. A skill with more than fifty files in it has
 * stopped being a skill and become a directory, and the model will do better
 * from the body's own pointers than from a listing that fills its context.
 */
async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (at: string): Promise<void> => {
    if (found.length >= SKILL_MAX_LISTED_FILES) return;
    let entries: string[];
    try {
      entries = await readdir(at);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (found.length >= SKILL_MAX_LISTED_FILES) return;
      if (name.startsWith('.')) continue;
      const path = join(at, name);
      let isDir: boolean;
      try {
        isDir = (await stat(path)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        await walk(path);
        continue;
      }
      // The entry point itself is the thing that was just returned; listing it
      // as something to go and read invites a second call for what the model is
      // already holding.
      if (at === dir && name === 'SKILL.md') continue;
      found.push(relative(dir, path).split(sep).join('/'));
    }
  };

  await walk(dir);
  return found;
}
