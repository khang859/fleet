import type {
  AdmiralThreadScope,
  AgencySettings,
  CrewRuntimeSettings
} from '../../../shared/agency';
import type { CrewRuntime } from '../../../shared/agency-crew';
import type { ProjectSetup } from '../../../shared/agency-projects';
import { jsonEqual } from '../../../shared/json-equal';
import {
  AGENCY_SETTING_KEYS,
  MEMBER_SETTING_FIELDS,
  memberSettingKey,
  parseSettingValue,
  settingKind,
  settingLabel,
  settingRule,
  settingTarget,
  settingValueText,
  type AdmiralSettingMark,
  type AgencySettingKey,
  type SettingTarget,
  type SettingValue,
  type SettingsCard,
  type SettingsUndoOutcome
} from '../../../shared/agency-settings';
import { loadSetup, updateSetup } from '../projects/project-store';
import type { AgencyStore } from '../store/agency-store';
import type { SettingWrite } from '../store/setting-change-store';

/** Where the agency settings live: Fleet's settings file, in the app. */
export type AgencySettingsAccess = {
  get: () => AgencySettings;
  set: (next: AgencySettings) => void;
};

export type SettingsServiceDeps = {
  store: AgencyStore;
  agency: AgencySettingsAccess;
  home: () => string;
  /** A setting or a card changed for a repository's lobby or job. */
  changed: (repoId: string, jobId: number | null) => void;
};

export type SettingsChangeRequest = {
  changes: Array<{ key: string; value: unknown }>;
  reason: string;
};

export type SettingsChangeOutcome =
  | { ok: false; reason: string }
  | { ok: true; card: SettingsCard | null; unchanged: string[] };

/** The Admiral's number settings, by key, with the field each one is. */
const ADMIRAL_NUMBERS = {
  'agency.admiral.defaultBudgetUsd': 'defaultBudgetUsd',
  'agency.admiral.monthlyCapUsd': 'monthlyCapUsd',
  'agency.admiral.defaultBudgetWeekPct': 'defaultBudgetWeekPct',
  'agency.admiral.reserveFiveHourPct': 'reserveFiveHourPct',
  'agency.admiral.reserveSevenDayPct': 'reserveSevenDayPct',
  'agency.admiral.nudgeLimit': 'nudgeLimit',
  'agency.admiral.turnLimit': 'turnLimit',
  'agency.admiral.permissionExpirySec': 'permissionExpirySec'
} as const satisfies Partial<Record<AgencySettingKey, keyof AgencySettings['admiral']>>;

type AdmiralNumberKey = keyof typeof ADMIRAL_NUMBERS;

const isAdmiralNumber = (key: AgencySettingKey): key is AdmiralNumberKey =>
  Object.hasOwn(ADMIRAL_NUMBERS, key);

function readAgency(settings: AgencySettings, key: AgencySettingKey): SettingValue {
  if (isAdmiralNumber(key)) return settings.admiral[ADMIRAL_NUMBERS[key]];
  switch (key) {
    case 'agency.enabled':
      return settings.enabled;
    case 'agency.admiral.model':
      return settings.admiral.model;
    case 'agency.crew.claude.atOnce':
      return settings.crew.claude.atOnce;
    case 'agency.crew.eva.atOnce':
      return settings.crew.eva.atOnce;
    case 'agency.crew.claude.defaultModel':
      return settings.crew.claude.defaultModel;
    case 'agency.crew.eva.defaultModel':
      return settings.crew.eva.defaultModel;
    case 'agency.crew.claude.permissionMode':
      return settings.crew.claude.permissionMode;
    case 'agency.crew.eva.permissionMode':
      return settings.crew.eva.permissionMode;
  }
}

/** One runtime's crew settings with a field changed. */
function writeCrew(
  settings: AgencySettings,
  runtime: CrewRuntime,
  patch: Partial<CrewRuntimeSettings>
): AgencySettings {
  return {
    ...settings,
    crew: { ...settings.crew, [runtime]: { ...settings.crew[runtime], ...patch } }
  };
}

/** `value` has passed the key's schema, so the type checks only narrow it. */
function writeAgency(
  settings: AgencySettings,
  key: AgencySettingKey,
  value: SettingValue
): AgencySettings {
  const { admiral } = settings;
  if (isAdmiralNumber(key)) {
    return typeof value === 'number'
      ? { ...settings, admiral: { ...admiral, [ADMIRAL_NUMBERS[key]]: value } }
      : settings;
  }
  switch (key) {
    case 'agency.enabled':
      return { ...settings, enabled: value === true };
    case 'agency.admiral.model':
      return { ...settings, admiral: { ...admiral, model: String(value ?? '') } };
    case 'agency.crew.claude.atOnce':
    case 'agency.crew.eva.atOnce':
      return writeCrew(settings, key === 'agency.crew.eva.atOnce' ? 'eva' : 'claude', {
        atOnce: typeof value === 'number' ? value : null
      });
    case 'agency.crew.claude.defaultModel':
    case 'agency.crew.eva.defaultModel':
      return writeCrew(settings, key === 'agency.crew.eva.defaultModel' ? 'eva' : 'claude', {
        defaultModel: String(value ?? '')
      });
    case 'agency.crew.claude.permissionMode':
    case 'agency.crew.eva.permissionMode':
      return writeCrew(settings, key === 'agency.crew.eva.permissionMode' ? 'eva' : 'claude', {
        permissionMode: value === 'auto' || value === 'bypass' ? value : 'default'
      });
  }
}

/**
 * The Admiral's settings tools and the client's answers to them. Whether a
 * change applies at once or waits on a card is the key's rule, never the
 * Admiral's say (`shared/agency-settings.ts`). Agency settings live in Fleet's
 * settings file; a member's live in the project's saved setup.
 */
export class AgencySettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  /** Every setting the Admiral can change, with its current value. */
  async values(repoId: string): Promise<Array<{ key: string; value: SettingValue }>> {
    const agency = this.deps.agency.get();
    const setup = await loadSetup(repoId, this.deps.home());
    return [
      ...AGENCY_SETTING_KEYS.map((key) => ({ key, value: readAgency(agency, key) })),
      ...(setup?.members ?? []).flatMap((m) =>
        MEMBER_SETTING_FIELDS.map((field) => ({
          key: memberSettingKey(m.name, field),
          value: m[field]
        }))
      )
    ];
  }

  /**
   * Check every change and write them all, on a card the client can Undo
   * from. One bad key refuses the whole call, so the Admiral never leaves half
   * of what it meant applied.
   */
  async change(
    scope: AdmiralThreadScope,
    req: SettingsChangeRequest
  ): Promise<SettingsChangeOutcome> {
    const checked = await this.check(scope.repoId, req);
    if (!checked.ok) return checked;
    const unchanged = checked.writes.filter((w) => jsonEqual(w.before, w.after));
    const changed = checked.writes.filter((w) => !jsonEqual(w.before, w.after));
    if (changed.length === 0) {
      return { ok: true, card: null, unchanged: unchanged.map((w) => w.key) };
    }
    await this.write(scope.repoId, changed);
    const id = this.deps.store.settings.addCard({
      repoId: scope.repoId,
      jobId: scope.jobId,
      reason: req.reason,
      changes: changed
    });
    this.deps.changed(scope.repoId, scope.jobId);
    return {
      ok: true,
      card: this.deps.store.settings.card(id),
      unchanged: unchanged.map((w) => w.key)
    };
  }

  /**
   * Put a written change back. Refused when the value moved on since, so an
   * Undo never throws away an edit made after the change.
   */
  async undo(changeId: number): Promise<SettingsUndoOutcome> {
    const { store } = this.deps;
    const change = store.settings.change(changeId);
    if (change === null || (change.status !== 'applied' && change.status !== 'approved')) {
      return { ok: false, reason: 'That change is not in place.' };
    }
    const now = await this.current(change.repoId, change.key);
    if (now === undefined || !jsonEqual(now, change.after)) {
      return { ok: false, reason: `${change.label} changed again since. Change it here instead.` };
    }
    const write = { key: change.key, before: change.after, after: change.before };
    await this.write(change.repoId, [write]);
    store.settings.undo(changeId, write);
    store.enqueueWakeup({
      repoId: change.repoId,
      jobId: change.jobId,
      kind: 'client_action',
      payload: {
        line: `Client undid a settings change`,
        note: `${change.label} is back to ${settingValueText(change.before)}.`
      }
    });
    this.deps.changed(change.repoId, change.jobId);
    return { ok: true };
  }

  /**
   * The settings the Admiral changed last and that still hold its value, for
   * "Changed by the Admiral" with Undo. A value the client edited since, in
   * Settings or by hand, is theirs again and has no mark.
   */
  async marks(repoId: string | null): Promise<AdmiralSettingMark[]> {
    const values =
      repoId === null
        ? AGENCY_SETTING_KEYS.map((key) => ({
            key,
            value: readAgency(this.deps.agency.get(), key)
          }))
        : await this.values(repoId);
    return values.flatMap(({ key, value }) => {
      const last = this.deps.store.settings.lastWrite(repoId ?? '', key);
      if (last?.actor !== 'admiral' || last.changeId === null) return [];
      if (!jsonEqual(last.after, value)) return [];
      return [
        { changeId: last.changeId, key, at: last.at, reason: last.reason, before: last.before }
      ];
    });
  }

  private async check(
    repoId: string,
    req: SettingsChangeRequest
  ): Promise<{ ok: true; writes: SettingWrite[] } | { ok: false; reason: string }> {
    const keys = req.changes.map((c) => c.key);
    const twice = keys.find((k, i) => keys.indexOf(k) !== i);
    if (twice !== undefined) return { ok: false, reason: `${twice} is in the call twice.` };
    const writes: SettingWrite[] = [];
    for (const c of req.changes) {
      const parsed = parseSettingValue(c.key, c.value);
      if (!parsed.ok)
        return { ok: false, reason: `${parsed.reason}. Call settings_read for the keys.` };
      const before = await this.current(repoId, c.key);
      if (before === undefined) return { ok: false, reason: await this.missing(repoId, c.key) };
      if (settingKind(c.key, before, parsed.value) === 'client-only') {
        return {
          ok: false,
          reason: `${settingLabel(c.key)}: ${settingRule(c.key)}. Nothing was changed. If the job cannot go on without it, ask the client with ask_client.`
        };
      }
      writes.push({ key: c.key, before, after: parsed.value });
    }
    return { ok: true, writes };
  }

  /** Why a member key has no value: no saved setup, or no member by that name. */
  private async missing(repoId: string, key: string): Promise<string> {
    const setup = await loadSetup(repoId, this.deps.home());
    if (setup === null) return 'The project has no saved setup yet, so it has no member settings.';
    const names = setup.members.map((m) => m.name).join(', ');
    return `${key} names no member of the project. Its members: ${names}.`;
  }

  /** A key's value now; undefined when it names a member the project does not have. */
  private async current(repoId: string, key: string): Promise<SettingValue | undefined> {
    const target = settingTarget(key);
    if (target === null) return undefined;
    if (target.scope === 'agency') return readAgency(this.deps.agency.get(), target.key);
    const setup = await loadSetup(repoId, this.deps.home());
    const member = setup?.members.find((m) => m.name === target.member);
    return member === undefined ? undefined : member[target.field];
  }

  /** Write changes: the agency ones to Fleet's settings, a member's to the project setup. */
  private async write(repoId: string, writes: SettingWrite[]): Promise<void> {
    const targets = writes.map((w) => ({ w, target: settingTarget(w.key) }));
    const agency = targets.flatMap(({ w, target }) =>
      target?.scope === 'agency' ? [{ key: target.key, value: w.after }] : []
    );
    if (agency.length > 0) {
      this.deps.agency.set(
        agency.reduce((s, { key, value }) => writeAgency(s, key, value), this.deps.agency.get())
      );
    }
    const members = targets.flatMap(({ w, target }) =>
      target?.scope === 'member' ? [{ w, target }] : []
    );
    if (members.length > 0) {
      await updateSetup(repoId, (setup) => withMembers(setup, members), this.deps.home());
    }
  }
}

function withMembers(
  setup: ProjectSetup,
  writes: Array<{ w: SettingWrite; target: Extract<SettingTarget, { scope: 'member' }> }>
): ProjectSetup {
  return {
    ...setup,
    members: setup.members.map((m) =>
      writes
        .filter(({ target }) => target.member === m.name)
        .reduce((acc, { w, target }) => ({ ...acc, [target.field]: w.after }), m)
    )
  };
}
