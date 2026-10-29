import type { AdmiralThreadScope } from '../../../shared/agency';
import {
  settingRule,
  settingValueText,
  settingsCardDisplayId,
  type SettingChange
} from '../../../shared/agency-settings';
import type { AgencyToolOutput, SettingsChangeArgs } from '../../../shared/agency-tools';
import type { AgencySettingsService } from '../settings';

/** Every setting the Admiral can change, one line each: key, value as JSON, and its rule. */
export async function settingsRead(
  settings: Pick<AgencySettingsService, 'values'>,
  scope: AdmiralThreadScope
): Promise<AgencyToolOutput> {
  const values = await settings.values(scope.repoId);
  const lines = values.map(
    ({ key, value }) => `${key} = ${JSON.stringify(value)} (${settingRule(key)})`
  );
  if (!values.some(({ key }) => key.startsWith('members.'))) {
    lines.push('The project has no saved setup yet, so it has no member settings.');
  }
  return { text: lines.join('\n'), summary: `${values.length} settings` };
}

const changeLine = (c: SettingChange): string =>
  `${c.key}: ${settingValueText(c.before)} -> ${settingValueText(c.after)}`;

/** Write the changes, on a card the client can Undo from. A refused call is a sentence for the model. */
export async function settingsChange(
  settings: Pick<AgencySettingsService, 'change'>,
  scope: AdmiralThreadScope,
  args: SettingsChangeArgs
): Promise<AgencyToolOutput> {
  const out = await settings.change(scope, args);
  if (!out.ok) return { text: `Nothing changed: ${out.reason}`, summary: 'not changed' };
  const same = out.unchanged.length > 0 ? [`Already set: ${out.unchanged.join(', ')}.`] : [];
  if (out.card === null) return { text: same.join('\n'), summary: 'no change' };
  const id = settingsCardDisplayId(out.card.id);
  const text = [`Changed now, with Undo on ${id}:`, ...out.card.changes.map(changeLine), ...same];
  return { text: text.join('\n'), summary: `card ${id}` };
}
