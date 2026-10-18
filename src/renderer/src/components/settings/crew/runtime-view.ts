import {
  runtimeProblems,
  runtimeWarnings,
  type CrewModel,
  type CrewRuntime,
  type CrewRuntimeView,
  type RoleDraft,
  type RuntimeCheckItem
} from '../../../../../shared/agency-crew';
import { formatPrice, formatTokens } from '../../agent/settings/format';
import { roleTitle } from './role-draft';

export type Tone = 'ok' | 'warn' | 'fail' | 'muted';

/** A runtime's state in one short line: ready, or how many checks failed or warn. */
export function runtimeState(view: CrewRuntimeView | undefined): { text: string; tone: Tone } {
  if (view === undefined) return { text: 'Checking…', tone: 'muted' };
  const problems = runtimeProblems(view.check).length;
  if (problems > 0) return { text: count(problems, 'problem'), tone: 'fail' };
  const warnings = runtimeWarnings(view.check).length;
  if (warnings > 0) return { text: count(warnings, 'warning'), tone: 'warn' };
  return { text: 'Ready', tone: 'ok' };
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `4 of 5 ok · 1 warning`, with the tone of the worst check. */
export function checkSummary(checks: RuntimeCheckItem[]): { text: string; tone: Tone } {
  const ok = checks.filter((c) => c.state === 'ok').length;
  const warn = checks.filter((c) => c.state === 'warn').length;
  const fail = checks.filter((c) => c.state === 'fail').length;
  const parts = [`${ok} of ${checks.length} ok`];
  if (fail > 0) parts.push(count(fail, 'problem'));
  if (warn > 0) parts.push(count(warn, 'warning'));
  return { text: parts.join(' · '), tone: fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'ok' };
}

/**
 * The checks a runtime shows. eva gets one more, its model list, which the
 * runtime check cannot see: a role's model is checked against it.
 */
export function shownChecks(runtime: CrewRuntime, view: CrewRuntimeView): RuntimeCheckItem[] {
  if (runtime === 'claude') return view.check.checks;
  const list: RuntimeCheckItem =
    view.models === null
      ? {
          name: 'Model list',
          state: 'warn',
          note: "eva's server did not list its models, so a role's model is not checked."
        }
      : {
          name: 'Model list',
          state: 'ok',
          note: `${view.models.length} models can call tools. A role's model is checked against them.`
        };
  return [...view.check.checks, list];
}

/** `3 roles: Architect, Strategist, Editor`, as the drafts have them. */
export function rolesLine(runtime: CrewRuntime, roles: readonly RoleDraft[]): string {
  const names = roles.filter((r) => r.runtime === runtime).map((r) => roleTitle(r.name));
  if (names.length === 0) return 'No roles';
  return `${count(names.length, 'role')}: ${names.join(', ')}`;
}

/**
 * The roles that run on `model`, by title. A role that names no model runs
 * on `fallback`, the default from Settings; `undefined` is the runtime's own.
 */
export function usedBy(
  runtime: CrewRuntime,
  model: string | undefined,
  fallback: string | undefined,
  roles: readonly RoleDraft[]
): string {
  const names = roles
    .filter((r) => r.runtime === runtime && (r.model ?? fallback) === model)
    .map((r) => roleTitle(r.name));
  return names.length === 0 ? 'No roles' : names.join(', ');
}

/**
 * A model's price per million tokens and its context, as far as the server
 * says, with units or without; null when it says neither.
 */
export function modelFigures(model: CrewModel, units: boolean): string | null {
  const parts = [
    model.cost === null ? null : `${formatPrice(model.cost)}${units ? ' per 1M' : ''}`,
    model.contextLimit === null
      ? null
      : `${formatTokens(model.contextLimit)}${units ? ' context' : ''}`
  ].filter((p) => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** What a model costs, as the Models table says it. */
export function modelCost(runtime: CrewRuntime, model: CrewModel): string {
  if (runtime === 'claude') return 'Your plan';
  return modelFigures(model, false) ?? '-';
}

const PROVIDER_LABEL: Record<string, string> = { openrouter: 'OpenRouter' };

export const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;

export type Fact = { label: string; value: string; tone?: Tone; mono?: boolean };

/** What Fleet can say of a runtime's account and server, never the login or the key. */
export function runtimeFacts(runtime: CrewRuntime, view: CrewRuntimeView): Fact[] {
  if (runtime === 'claude') {
    return [
      {
        label: 'Account',
        ...(view.signedIn === null
          ? { value: 'Could not check the sign-in', tone: 'muted' }
          : view.signedIn
            ? { value: 'Signed in with your Claude account' }
            : { value: 'Not signed in. Run claude in a terminal to sign in.', tone: 'fail' })
      },
      {
        label: 'Usage',
        ...(view.limited === null
          ? { value: 'Not at a usage limit' }
          : { value: `Claude Code is ${view.limited} New hires wait.`, tone: 'warn' })
      },
      { label: 'Mode', value: 'The normal Claude Code app in a Fleet pane' }
    ];
  }
  const server = view.server;
  if (server === null) {
    return [{ label: 'Model server', value: "Could not read eva's settings", tone: 'muted' }];
  }
  return [
    {
      label: 'Model server',
      value: `${providerLabel(server.provider)} · ${server.local ? 'local' : 'remote'}`
    },
    server.baseUrl === null
      ? { label: 'Address', value: "eva's default for the provider", tone: 'muted' }
      : { label: 'Address', value: server.baseUrl, mono: true },
    { label: 'Key', ...keyFact(view.signedIn, server.local) }
  ];
}

function keyFact(keySet: boolean | null, local: boolean): Omit<Fact, 'label'> {
  if (keySet === true) return { value: 'Key set in eva', tone: 'ok' };
  if (keySet === null) return { value: 'Could not check', tone: 'muted' };
  return local ? { value: 'No key needed' } : { value: 'No key in eva', tone: 'warn' };
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-300',
  fail: 'text-red-600 dark:text-red-300',
  muted: 'text-fleet-text-subtle'
};

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-500 dark:bg-emerald-400',
  warn: 'bg-amber-400',
  fail: 'bg-red-500 dark:bg-red-400',
  muted: 'bg-fleet-text-subtle'
};
