import type { AgentToolContext } from '../../../shared/agent-tools';
import type { AgentFleetCapability } from '../../../shared/fleet-tools';
import { capabilityMember } from './member';

/**
 * The capability member behind a fleet tool, or a sentence saying why there is
 * none. Only reached by a call the model was not offered - from a pane not in
 * orchestrator mode, a subagent reaching for an act tool, or a replay of an
 * older transcript - so the answer says what to do instead.
 */
export function fleetMember<K extends keyof AgentFleetCapability>(
  ctx: AgentToolContext,
  name: string,
  key: K
): NonNullable<AgentFleetCapability[K]> {
  return capabilityMember(
    ctx.fleet,
    key,
    `${name} works only in an Agent pane in orchestrator mode. Ask the user to turn it on if you need it.`,
    // An orchestrator turn has every act tool but this one only when the user
    // turned it on, which is the thing to say.
    (fleet) =>
      key === 'permission' && fleet.send !== null
        ? `${name} is off: answering a session's permission requests is a setting the user turns on (Agent settings, Permissions). Until then the user answers them in the session's terminal.`
        : `${name} is not available in this conversation.`
  );
}
