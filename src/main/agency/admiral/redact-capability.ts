import type { Redactor } from '../../redactor';

type Member = ((...args: never[]) => Promise<{ text: string; summary: string }>) | null;

/**
 * A capability whose every output has the project's env file values masked,
 * read again on each call, so a file the client gives crew mid-turn is masked
 * from its next call on.
 */
export function redactOutputs<C extends { [K in keyof C]: Member }>(
  capability: C,
  redactor: () => Promise<Redactor>
): C {
  const wrap = (run: NonNullable<Member>): NonNullable<Member> => {
    return async (...args) => {
      const out = await run(...args);
      const r = await redactor();
      return { text: r.redact(out.text), summary: r.redact(out.summary) };
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the same members, wrapped
  return Object.fromEntries(
    Object.entries<Member>(capability).map(([key, run]) => [key, run === null ? null : wrap(run)])
  ) as C;
}
