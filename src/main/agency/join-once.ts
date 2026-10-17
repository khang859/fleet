/** Run `fn` for `key`, or join the run under way for it. */
export async function joinOnce(
  runs: Map<number, Promise<void>>,
  key: number,
  fn: () => Promise<void>
): Promise<void> {
  const under = runs.get(key);
  if (under) return under;
  const run = fn().finally(() => runs.delete(key));
  runs.set(key, run);
  return run;
}
