/**
 * The member of a nullable tool capability behind a tool, or the sentence the
 * model reads when there is none: `absent` when the turn has no capability at
 * all, `unavailable` when it has one without this member.
 */
export function capabilityMember<C extends object, K extends keyof C>(
  capability: C | null,
  key: K,
  absent: string,
  unavailable: (capability: C) => string
): NonNullable<C[K]> {
  if (capability === null) throw new Error(absent);
  const run = capability[key];
  if (run === null || run === undefined) throw new Error(unavailable(capability));
  return run as NonNullable<C[K]>;
}
