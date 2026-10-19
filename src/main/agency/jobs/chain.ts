import { DEFAULT_AGENCY_SETTINGS, type AgencySettings } from '../../../shared/agency';
import { parseSettingValue } from '../../../shared/agency-settings';

/**
 * How many automatic Admiral turns a job takes in a row before it stops and
 * asks the client whether to go on: the client's `agency.admiral.turnLimit`,
 * or its default when the stored value is missing or out of range. A client
 * action or a finished step resets the count.
 */
export function chainLimit(admiral: AgencySettings['admiral']): number {
  const parsed = parseSettingValue('agency.admiral.turnLimit', admiral.turnLimit);
  return parsed.ok && typeof parsed.value === 'number'
    ? parsed.value
    : DEFAULT_AGENCY_SETTINGS.admiral.turnLimit;
}

/** Whether a job that took `count` automatic turns in a row must ask before the next. */
export function chainExhausted(count: number, limit: number): boolean {
  return count >= limit;
}
