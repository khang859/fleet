import type { AgentToolSpec } from './agent-tools';

/**
 * The tools a nullable capability offers: none without it, and of the rest only
 * those with a member behind them, so a tool is never offered that cannot run.
 */
export function offeredToolSpecs<C extends object>(
  capability: C | null,
  specs: readonly AgentToolSpec[],
  members: Readonly<Record<string, keyof C>>
): AgentToolSpec[] {
  if (capability === null) return [];
  return specs.filter((spec) => {
    const name = spec.function.name;
    return Object.hasOwn(members, name) && capability[members[name]] !== null;
  });
}
