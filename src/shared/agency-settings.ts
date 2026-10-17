import { z } from 'zod';
import type { ProjectMemberSetup } from './agency-projects';

/**
 * Every setting the Admiral can read and change, and which kind each change
 * is. The kind comes from the key and the direction of the change, never from
 * the Admiral, so an instruction injected into a page it read can at most put
 * a card in front of the client.
 *
 * - `apply`: gives no more money or reach, so it is written at once with Undo.
 * - `approve`: gives more, so it waits on a card for the client's OK.
 * - `client-only`: the Admiral's own model and Agency itself, which only the
 *   client changes, in Settings.
 */
export type SettingKind = 'apply' | 'approve' | 'client-only';

/** A setting's value as JSON: what the tool takes and the history keeps. */
export type SettingValue = string | number | boolean | string[] | null;

type SettingDef = {
  label: string;
  schema: z.ZodType<SettingValue>;
  kind: (before: SettingValue, after: SettingValue) => SettingKind;
  /** What a change to it needs, for `settings_read`. */
  rule: string;
};

const apply = {
  kind: (): SettingKind => 'apply',
  rule: 'applies at once'
};
const clientOnly = {
  kind: (): SettingKind => 'client-only',
  rule: 'only the client changes it, in Settings > Agency > Admiral'
};
/** More money is the client's call; less is not. */
const moreNeedsOk = {
  kind: (before: SettingValue, after: SettingValue): SettingKind =>
    typeof before === 'number' && typeof after === 'number' && after <= before
      ? 'apply'
      : 'approve',
  rule: "lowering it applies at once; raising it needs the client's OK"
};
/** Waiting for one more check or bot costs nothing; dropping one lets work through unchecked. */
const droppingNeedsOk = {
  kind: (before: SettingValue, after: SettingValue): SettingKind => {
    const kept = new Set(Array.isArray(after) ? after : []);
    return (Array.isArray(before) ? before : []).every((v) => kept.has(v)) ? 'apply' : 'approve';
  },
  rule: "adding one applies at once; removing one needs the client's OK"
};

const Usd = z.number().min(0).max(100_000);
const Text = z.string().max(2_000);
const List = z.array(z.string().max(400)).max(200);

/** Agency settings, the same for every project. */
const AGENCY_SETTINGS = {
  'agency.enabled': { label: 'Agency on', schema: z.boolean(), ...clientOnly },
  'agency.admiral.model': { label: 'Admiral model', schema: z.string().max(200), ...clientOnly },
  'agency.admiral.defaultBudgetUsd': {
    label: 'Default job budget (USD)',
    schema: Usd,
    ...moreNeedsOk
  },
  'agency.admiral.monthlyCapUsd': {
    label: 'Monthly cap (USD)',
    schema: Usd,
    ...moreNeedsOk
  }
} satisfies Record<string, SettingDef>;

export type AgencySettingKey = keyof typeof AGENCY_SETTINGS;

/** The fields of a project member the Admiral can change, as `members.<name>.<field>`. */
const MEMBER_SETTINGS = {
  setupCommand: { label: 'setup command', schema: Text, ...apply },
  setupTimeoutSec: {
    label: 'setup timeout (seconds)',
    schema: z.number().int().min(10).max(7_200),
    ...apply
  },
  checkCommands: { label: 'check commands', schema: List, ...apply },
  checks: { label: 'CI checks', schema: List, ...apply },
  requiredChecks: { label: 'required checks', schema: List, ...droppingNeedsOk },
  reviewBots: { label: 'review bots', schema: List, ...droppingNeedsOk },
  stack: { label: 'stack', schema: List, ...apply },
  packageManager: { label: 'package manager', schema: z.string().max(80).nullable(), ...apply },
  defaultBranch: { label: 'default branch', schema: z.string().max(200).nullable(), ...apply }
} satisfies Partial<Record<keyof ProjectMemberSetup, SettingDef>>;

export type MemberSettingField = keyof typeof MEMBER_SETTINGS;

/** Where a key's value lives. */
export type SettingTarget =
  | { scope: 'agency'; key: AgencySettingKey }
  | { scope: 'member'; member: string; field: MemberSettingField };

const MEMBER_KEY = /^members\.(.+)\.([A-Za-z]+)$/;

const isAgencyKey = (key: string): key is AgencySettingKey => Object.hasOwn(AGENCY_SETTINGS, key);
const isMemberField = (field: string): field is MemberSettingField =>
  Object.hasOwn(MEMBER_SETTINGS, field);

export function settingTarget(key: string): SettingTarget | null {
  if (isAgencyKey(key)) return { scope: 'agency', key };
  const m = MEMBER_KEY.exec(key);
  if (m === null || !isMemberField(m[2])) return null;
  return { scope: 'member', member: m[1], field: m[2] };
}

export function memberSettingKey(member: string, field: MemberSettingField): string {
  return `members.${member}.${field}`;
}

function definition(target: SettingTarget): SettingDef {
  return target.scope === 'agency' ? AGENCY_SETTINGS[target.key] : MEMBER_SETTINGS[target.field];
}

/** A key as the client reads it: "Default job budget (USD)", "web: setup command". */
export function settingLabel(key: string): string {
  const target = settingTarget(key);
  if (target === null) return key;
  const { label } = definition(target);
  return target.scope === 'agency' ? label : `${target.member}: ${label}`;
}

/** Check a value against its key's schema. */
export function parseSettingValue(
  key: string,
  value: unknown
): { ok: true; value: SettingValue } | { ok: false; reason: string } {
  const target = settingTarget(key);
  if (target === null) return { ok: false, reason: `${key} is not a setting` };
  const parsed = definition(target).schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `${key}: ${parsed.error.issues[0]?.message ?? 'not valid'}` };
  }
  return { ok: true, value: parsed.data };
}

/** What a change to a key needs, in words. */
export function settingRule(key: string): string {
  const target = settingTarget(key);
  return target === null ? '' : definition(target).rule;
}

/** Which kind a change is, from its key and its direction. */
export function settingKind(key: string, before: SettingValue, after: SettingValue): SettingKind {
  const target = settingTarget(key);
  return target === null ? 'client-only' : definition(target).kind(before, after);
}

/** A value as one line of text, for cards and the model. */
export function settingValueText(value: SettingValue): string {
  if (value === null || value === '') return '(none)';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  return String(value);
}

/** The agency keys, in the order `settings_read` lists them. */
export const AGENCY_SETTING_KEYS = Object.keys(AGENCY_SETTINGS).filter(isAgencyKey);
/** The member fields, in the order `settings_read` lists them. */
export const MEMBER_SETTING_FIELDS = Object.keys(MEMBER_SETTINGS).filter(isMemberField);

/**
 * Where a change stands. `applied` was written at once and `approved` once the
 * client said yes; a refused change was never written, and an undone one was
 * put back.
 */
export type SettingChangeStatus = 'applied' | 'pending' | 'approved' | 'refused' | 'undone';

/** One change to one setting, as a card and Settings show it. */
export type SettingChange = {
  id: number;
  key: string;
  label: string;
  before: SettingValue;
  after: SettingValue;
  kind: Exclude<SettingKind, 'client-only'>;
  status: SettingChangeStatus;
};

/** The changes one `settings_change` call made or asked for, with its reason. */
export type SettingsCard = {
  id: number;
  repoId: string;
  jobId: number | null;
  at: number;
  reason: string;
  changes: SettingChange[];
};

/** A setting the Admiral changed last, for "Changed by the Admiral" with Undo. */
export type AdmiralSettingMark = {
  changeId: number;
  key: string;
  at: number;
  reason: string;
  before: SettingValue;
};

/** What an Undo did: refused when the value moved on since the change. */
export type SettingsUndoOutcome = { ok: true } | { ok: false; reason: string };

/** `settings_card` ids as the model and the client read them: `s3`. */
export function settingsCardDisplayId(id: number): string {
  return `s${id}`;
}
