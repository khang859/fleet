import { gitExec } from '../exec';

/**
 * Check out one submodule of an umbrella at the commit the umbrella pins, the
 * way `git submodule update --init` does by hand. Only that submodule: its own
 * submodules stay as they are.
 */
export async function checkOutSubmodule(umbrellaRoot: string, path: string): Promise<void> {
  const out = await gitExec(['submodule', 'update', '--init', '--', path], umbrellaRoot);
  if (out === null)
    throw new Error(
      `Could not check out ${path}. Run git submodule update --init -- ${path} in ${umbrellaRoot} to see why.`
    );
}
