import { join } from '../../../shared/path-platform';
import type { PathContext } from '../../../shared/shell-profiles';

/**
 * The scratch folder, as the renderer sees it.
 *
 * A second copy of what `src/main/agent/scratch-dir.ts` computes, and it has to
 * agree with it exactly: the string is what the session store groups scratch
 * conversations by, and what the file tools sandbox against. Two folders that
 * differ by a separator would quietly become two different conversations.
 *
 * It cannot be shared. `shared/constants.ts` says in as many words that the
 * main-process paths there must not be imported from renderer code, because they
 * are built with `node:path` and `node:os`, neither of which exists here. So
 * both sides join the same two literal segments onto a home directory that is
 * already guaranteed to match - `window.fleet.homeDir` is `os.homedir()`, read
 * in the preload.
 *
 * Worked out on first use rather than at import, and remembered after. The home
 * directory does not change while the app runs, so this is a constant in every
 * way that matters, but computing it while the module loads would make merely
 * importing anything that reaches this file depend on the preload bridge being
 * up - which is true in the app and false in a unit test, where the bridge is a
 * partial mock and the answer is never asked for anyway.
 */
let cached: string | null = null;

/**
 * The preload bridge, as something that might not be there.
 *
 * Read through a function because the DOM types declare `window.fleet` as
 * always present with every field on it, which is exactly the claim this exists
 * to disprove: a unit test mounts a partial mock of it, and this is the one
 * caller that runs before anything has checked. A declared return type survives
 * where a `const` annotation would just be narrowed back by its initializer -
 * the same trick, for the same reason, as `existingLocalStorage` in the test
 * setup.
 */
function bridge(): Partial<typeof window.fleet> | undefined {
  return window.fleet;
}

export function scratchDir(): string {
  if (cached !== null) return cached;
  const ctx: PathContext = bridge()?.platform === 'win32' ? 'win32' : 'posix';
  // An absent home is not a case worth inventing a path for: it means the
  // preload bridge is not up, and the only caller that can be running then is a
  // tab predicate answering about tabs that cannot exist yet. Empty segments are
  // dropped by `join`, so the answer is a path nothing will ever equal.
  const home = bridge()?.homeDir ?? '';
  cached = join(ctx, home, '.fleet', 'scratch');
  return cached;
}

/**
 * Whether a tab is the pinned scratch chat.
 *
 * By folder rather than by type, which is what makes the tab possible at all: it
 * is an `agent` tab like any other, so the pane, the session list and the layout
 * all work on it unchanged, and the only thing that marks it out is where it is
 * rooted. Every place that treats the pinned tools as a class has to ask this as
 * well as reading `type`, because `type` alone cannot tell a scratch tab from a
 * project one.
 *
 * Typed structurally rather than as `Pick<Tab, ...>` so the tab-cycling filter,
 * which is generic over anything with a type and a cwd, can call it too.
 */
export function isScratchTab(tab: { type?: string; cwd: string }): boolean {
  return tab.type === 'agent' && tab.cwd === scratchDir();
}
