import type { AgentToolContext } from '../../../shared/agent-tools';
import type { AgentAgencyCapability } from '../../../shared/agency-tools';
import { capabilityMember } from './member';

/**
 * The capability member behind an agency tool, or a sentence saying why there
 * is none. Only reached by a call the model was not offered: from a pane that
 * is not an Admiral, `job_open` from a job thread, or a replayed transcript.
 */
export function agencyMember<K extends keyof AgentAgencyCapability>(
  ctx: AgentToolContext,
  name: string,
  key: K
): NonNullable<AgentAgencyCapability[K]> {
  return capabilityMember(ctx.agency, key, `${name} works only in an Admiral pane.`, () =>
    key === 'jobOpen'
      ? `${name} works only on the Bridge. This conversation is already a job; to start another, ask the client to brief it on the Bridge.`
      : `${name} is not available in this conversation.`
  );
}
