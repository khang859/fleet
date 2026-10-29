import { z } from 'zod';
import { AT_ONCE_MAX } from './agency-crew';
import type { ProjectMemberSetup } from './agency-projects';

/**
 * Every setting the Admiral can read and change, and which kind each change
 * is. The kind comes from the key and the direction of the change, never from
 * the Admiral, so an instruction injected into a page it read cannot loosen a
 * brake the client owns.
 *
 * - `apply`: written at once, with Undo.
 * - `client-only`: a brake on the Admiral itself (its model, the monthly cap,
 *   the Claude reserve, the checks a PR must pass, secrets for crew), which
 *   only the client loosens, in Settings.
 */
export type SettingKind = 'apply' | 'client-only';

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
/** A higher cap is the client's call; a lower one is not. */
const moreIsClientOnly = {
  kind: (before: SettingValue, after: SettingValue): SettingKind =>
    typeof before === 'number' && typeof after === 'number' && after <= before
      ? 'apply'
      : 'client-only',
  rule: 'lowering it applies at once; only the client raises it, in Settings > Agency > Admiral'
};

/** Waiting for one more check or bot costs nothing; dropping one lets work through unchecked. */
const droppingIsClientOnly = {
  kind: (before: SettingValue, after: SettingValue): SettingKind => {
    const kept = new Set(Array.isArray(after) ? after : []);
    return (Array.isArray(before) ? before : []).every((v) => kept.has(v))
      ? 'apply'
      : 'client-only';
  },
  rule: 'adding one applies at once; only the client removes one, in project setup'
};

/** Crew getting one more env file is the client's call; getting one less is not. */
const addingIsClientOnly = {
  kind: (before: SettingValue, after: SettingValue): SettingKind => {
    const had = new Set(Array.isArray(before) ? before : []);
    return (Array.isArray(after) ? after : []).every((v) => had.has(v)) ? 'apply' : 'client-only';
  },
  rule: 'removing one applies at once; only the client adds one, in project setup'
};

/** A crew mode that asks the Admiral less: only the client turns it on. */
const onIsClientOnly = {
  kind: (_before: SettingValue, after: SettingValue): SettingKind =>
    after === 'default' ? 'apply' : 'client-only',
  rule: 'turning it off applies at once; only the client turns it on, in Settings > Agency > Crew'
};

const Usd = z.number().min(0).max(100_000);
/** A share of a Claude usage window, in percent. */
const Pct = z.number().min(1).max(100);
/** Crew of one runtime at once; null takes the runtime's default. */
const AtOnce = z.number().int().min(1).max(AT_ONCE_MAX).nullable();
const Model = z.string().max(200);
const Text = z.string().max(2_000);
const List = z.array(z.string().max(400)).max(200);

/** The most nudges the client can allow an idle crew member. */
export const NUDGE_LIMIT_MAX = 20;
/** The most automatic Admiral turns the client can allow a job in a row. */
export const TURN_LIMIT_MAX = 200;
/** The shortest and longest a client permission card waits, in seconds. */
export const PERMISSION_EXPIRY_MIN_SEC = 30;
export const PERMISSION_EXPIRY_MAX_SEC = 3_600;

/** Agency settings, the same for every project. */
const AGENCY_SETTINGS = {
  'agency.enabled': { label: 'Agency on', schema: z.boolean(), ...clientOnly },
  'agency.admiral.model': { label: 'Admiral model', schema: z.string().max(200), ...clientOnly },
  'agency.admiral.defaultBudgetUsd': {
    label: 'Default job budget (USD)',
    schema: Usd,
    ...apply
  },
  'agency.admiral.monthlyCapUsd': {
    label: 'Monthly cap (USD)',
    schema: Usd,
    ...moreIsClientOnly
  },
  'agency.admiral.defaultBudgetWeekPct': {
    label: 'Default job share of the weekly Claude limit (%)',
    schema: Pct,
    ...apply
  },
  // A higher line leaves the user less of their own subscription.
  'agency.admiral.reserveFiveHourPct': {
    label: 'Claude crew stop at this much of the 5-hour window (%)',
    schema: Pct,
    ...moreIsClientOnly
  },
  'agency.admiral.reserveSevenDayPct': {
    label: 'Claude crew stop at this much of the weekly limit (%)',
    schema: Pct,
    ...moreIsClientOnly
  },
  // Each nudge is another crew turn the job pays for.
  'agency.admiral.nudgeLimit': {
    label: 'Nudges per idle crew member',
    schema: z.number().int().min(0).max(NUDGE_LIMIT_MAX),
    ...apply
  },
  // Each automatic turn is another Admiral turn the job pays for.
  'agency.admiral.turnLimit': {
    label: 'Automatic turns before a job asks to continue',
    schema: z.number().int().min(1).max(TURN_LIMIT_MAX),
    ...moreIsClientOnly
  },
  // How long the client has to answer a crew permission card is theirs to set.
  'agency.admiral.permissionExpirySec': {
    label: 'Permission card expiry (seconds)',
    schema: z.number().int().min(PERMISSION_EXPIRY_MIN_SEC).max(PERMISSION_EXPIRY_MAX_SEC),
    ...clientOnly
  },
  'agency.crew.claude.atOnce': { label: 'Claude crew at once', schema: AtOnce, ...apply },
  'agency.crew.eva.atOnce': { label: 'eva crew at once', schema: AtOnce, ...apply },
  'agency.crew.claude.defaultModel': {
    label: 'Default Claude Code model',
    schema: Model,
    ...apply
  },
  'agency.crew.eva.defaultModel': { label: 'Default eva model', schema: Model, ...apply },
  'agency.crew.claude.permissionMode': {
    label: 'Claude crew permission mode',
    schema: z.enum(['default', 'auto']),
    ...onIsClientOnly
  },
  'agency.crew.eva.permissionMode': {
    label: 'eva crew bypass mode',
    schema: z.enum(['default', 'bypass']),
    ...onIsClientOnly
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
  requiredChecks: { label: 'required checks', schema: List, ...droppingIsClientOnly },
  reviewBots: { label: 'review bots', schema: List, ...droppingIsClientOnly },
  stack: { label: 'stack', schema: List, ...apply },
  packageManager: { label: 'package manager', schema: z.string().max(80).nullable(), ...apply },
  defaultBranch: { label: 'default branch', schema: z.string().max(200).nullable(), ...apply },
  portVars: { label: 'port variables', schema: List, ...apply },
  envFiles: { label: 'env files for crew', schema: List, ...addingIsClientOnly }
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
 * Where a change stands. `applied` was written at once; an undone one was put
 * back. `approved` and `refused` are kept only for changes from before every
 * change applied at once, when some waited on the client.
 */
export type SettingChangeStatus = 'applied' | 'approved' | 'refused' | 'undone';

/** One change to one setting, as a card and Settings show it. */
export type SettingChange = {
  id: number;
  key: string;
  label: string;
  before: SettingValue;
  after: SettingValue;
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
