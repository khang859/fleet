import { relative } from 'node:path';
import {
  fence,
  FLEET_DIFF_MAX_CHARS,
  FLEET_LOG_COMMITS,
  type FleetDiffArgs,
  type FleetToolOutput
} from '../../../shared/fleet-tools';
import { DENIED_PATHSPECS, realpathOrNearest, resolveInsideCwd } from '../tools/paths';
import { runRead } from '../tools/read';
import { resolveSession, type FleetHost } from './host';

/**
 * Flags every diff takes: an external diff tool or a textconv filter is a
 * program the repository's config names, and Fleet only reads.
 */
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--relative'];

function clipOutput(text: string): string {
  if (text.length <= FLEET_DIFF_MAX_CHARS) return text;
  const more = text.length - FLEET_DIFF_MAX_CHARS;
  return `${text.slice(0, FLEET_DIFF_MAX_CHARS)}\n[cut: ${more} more characters. Narrow it with \`path\`.]`;
}

/**
 * The pathspec a view is limited to: the asked-for path, checked against the
 * session folder and the credential rules, or else the whole session folder.
 * Credential files are left out either way.
 */
function pathspec(path: string | undefined, cwd: string): string[] {
  if (path === undefined) return ['--', '.', ...DENIED_PATHSPECS];
  const real = resolveInsideCwd(path, cwd);
  const rel = relative(realpathOrNearest(cwd), real) || '.';
  // Literal, so a path cannot be pathspec magic: `:(top)` names the repository
  // root, which in a monorepo is far wider than the session folder.
  return ['--', `:(literal)${rel}`, ...DENIED_PATHSPECS];
}

/** Ignoring only the one failure an unborn branch gives: there is no HEAD to diff against. */
async function orUnborn(run: Promise<string>): Promise<string> {
  try {
    return await run;
  } catch (err) {
    if (
      /ambiguous argument 'HEAD'|bad revision 'HEAD'|does not have any commits/i.test(String(err))
    ) {
      return '(no commits yet)';
    }
    throw err;
  }
}

/** `fleet_diff`. */
export async function diffSession(
  host: FleetHost,
  threadId: string,
  args: FleetDiffArgs
): Promise<FleetToolOutput> {
  const session = resolveSession(host, args.session);
  const cwd = session.cwd;
  const git = async (argv: string[]): Promise<string> => {
    try {
      return (await host.git(cwd, argv)).stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not a git repository/i.test(message)) {
        throw new Error(`${session.ref} is not in a git repository (${cwd}).`);
      }
      throw err;
    }
  };

  switch (args.view) {
    case 'stat': {
      const spec = pathspec(args.path, cwd);
      const status = await git([
        'status',
        '--porcelain=v1',
        '--branch',
        '--untracked-files=normal',
        ...spec
      ]);
      const stat = await orUnborn(git(['diff', 'HEAD', '--stat', ...DIFF_FLAGS, ...spec]));
      const body = clipOutput(
        `git status:\n${status.trimEnd()}\n\nChanges against HEAD:\n${stat.trimEnd() || '(none)'}`
      );
      // The stat's own last line, "2 files changed, 5 insertions(+)", is the
      // one thing a person scanning the row wants from it.
      const total = stat.trimEnd().split('\n').at(-1)?.trim() ?? '';
      return { text: fence(session.ref, body), summary: total === '' ? 'no changes' : total };
    }
    case 'diff': {
      const out = await orUnborn(git(['diff', 'HEAD', ...DIFF_FLAGS, ...pathspec(args.path, cwd)]));
      const body = out.trim() === '' ? 'No changes against HEAD.' : clipOutput(out.trimEnd());
      const files = out.split('\n').filter((l) => l.startsWith('diff --git ')).length;
      return {
        text: fence(session.ref, body),
        summary: files === 0 ? 'no changes' : `${files} file${files === 1 ? '' : 's'}`
      };
    }
    case 'log': {
      const out = await orUnborn(
        git([
          'log',
          `-n${FLEET_LOG_COMMITS}`,
          '--no-decorate',
          '--no-color',
          '--date=short',
          '--format=%h %ad %an: %s',
          ...pathspec(args.path, cwd)
        ])
      );
      return {
        text: fence(session.ref, clipOutput(out.trimEnd() || 'No commits.')),
        summary: commitCount(out)
      };
    }
    case 'file': {
      if (args.path === undefined) throw new Error('The file view needs `path`.');
      // The Agent's own reader with the session's folder as its sandbox, so the
      // same confinement and credential rules hold. Kept apart from this
      // conversation's own reads, so it never licenses an edit.
      const result = await runRead(
        { path: args.path, offset: args.offset, limit: args.limit },
        { cwd, threadId: `fleet:${threadId}` }
      );
      if (result.image) {
        return {
          text: `${args.path} is an image; fleet_diff does not show images.`,
          summary: 'image'
        };
      }
      return { text: fence(session.ref, result.text), summary: result.summary };
    }
  }
}

function commitCount(log: string): string {
  const n = log.trim() === '' ? 0 : log.trimEnd().split('\n').length;
  return n === 0 ? 'no commits' : `${n} commit${n === 1 ? '' : 's'}`;
}
