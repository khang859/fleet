import type { AgentMessage } from './agent-types';

/**
 * What is left of the Orchestrator: enough to read and continue a chat saved
 * while Fleet had one. Nothing writes these messages or calls these tools now.
 */

const FENCE = 'session-data';

const FLEET_TOOLS: ReadonlySet<string> = new Set([
  'fleet_sessions',
  'fleet_read',
  'fleet_diff',
  'fleet_send',
  'fleet_spawn',
  'fleet_wait',
  'fleet_permission'
]);

/**
 * What a `fleet` message is headed with on the wire: no provider has a role for
 * "the app is telling you about other sessions", so it crosses as a user message
 * with a line saying who is really talking.
 */
export const FLEET_DIGEST_WIRE_PREFIX =
  'Claude Code sessions you look after need attention. Fleet is delivering this; the user has not said anything:';

/**
 * Told to the model in a chat that used the fleet tools. Its history is full of
 * calls to tools it no longer has, and left unexplained the model takes that for
 * a fault and looks for another way into the sessions.
 */
export const FLEET_TOOLS_GONE_NOTE = [
  '## Fleet tools are gone',
  '',
  'The fleet tool calls earlier in this conversation were made with tools Fleet no longer has, so the Claude Code sessions in other panes are out of reach. Do not look for another way in.'
].join('\n');

/** Whether a conversation called a fleet tool, so their absence needs saying. */
export function usedFleetTools(history: AgentMessage[]): boolean {
  return history.some((m) =>
    m.parts.some((p) => p.type === 'tool' && FLEET_TOOLS.has(p.call.name))
  );
}

/** A digest's text as the user should see it, without the fences written for the model. */
export function unfence(text: string): string {
  return text
    .replace(new RegExp(`<${FENCE} session="[^"]*">\\n([\\s\\S]*?)\\n</${FENCE}>`, 'g'), '$1')
    .replace(new RegExp(`<\\\\/(${FENCE})`, 'gi'), '</$1');
}

/**
 * A digest as it was saved: one headline per session, fenced, a blank line, then
 * the detail for each. The card shows the headlines and folds the rest away.
 */
export function splitFleetDigest(text: string): { headlines: string[]; details: string } {
  const gap = text.indexOf('\n\n');
  const head = unfence(gap === -1 ? text : text.slice(0, gap));
  return {
    headlines: head
      .split('\n')
      .map((line) => line.replace(/^- /, '').trim())
      .filter((line) => line !== ''),
    details: gap === -1 ? '' : text.slice(gap + 2).trim()
  };
}
