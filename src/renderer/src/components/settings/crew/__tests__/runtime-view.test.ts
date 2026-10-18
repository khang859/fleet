import { describe, expect, it } from 'vitest';
import type {
  CrewRuntimeView,
  RoleDraft,
  RuntimeCheckItem
} from '../../../../../../shared/agency-crew';
import {
  checkSummary,
  modelCost,
  rolesLine,
  runtimeFacts,
  runtimeState,
  shownChecks,
  usedBy
} from '../runtime-view';

const ok = (name: string): RuntimeCheckItem => ({ name, state: 'ok', note: `${name} works.` });

const view = (over: Partial<CrewRuntimeView> = {}): CrewRuntimeView => ({
  check: { runtime: 'claude', path: '/bin/claude', version: '2.1.302', checks: [ok('Installed')] },
  server: null,
  models: null,
  signedIn: true,
  limited: null,
  defaultAtOnce: 2,
  ...over
});

const role = (name: string, runtime: RoleDraft['runtime'], model?: string): RoleDraft => ({
  name,
  description: 'A role.',
  runtime,
  model,
  stack: false,
  instructions: 'Work.'
});

const ROLES = [
  role('architect', 'claude', 'opus'),
  role('qa', 'claude'),
  role('builder', 'eva', 'qwen/qwen3-coder'),
  role('reviewer', 'eva')
];

describe('runtimeState', () => {
  it('counts problems first, then warnings', () => {
    const checks: RuntimeCheckItem[] = [
      ok('Installed'),
      { name: 'Vim mode off', state: 'warn', note: 'Vim mode is on.' },
      { name: 'Hooks on', state: 'fail', note: 'Hooks are off.' },
      { name: 'Fleet hook', state: 'fail', note: 'No hook.' }
    ];
    expect(runtimeState(view({ check: { ...view().check, checks } }))).toEqual({
      text: '2 problems',
      tone: 'fail'
    });
    expect(runtimeState(view({ check: { ...view().check, checks: checks.slice(0, 2) } }))).toEqual({
      text: '1 warning',
      tone: 'warn'
    });
    expect(runtimeState(view())).toEqual({ text: 'Ready', tone: 'ok' });
    expect(runtimeState(undefined).tone).toBe('muted');
  });
});

describe('checkSummary', () => {
  it('says how many pass, and the worst tone', () => {
    expect(
      checkSummary([ok('A'), ok('B'), { name: 'C', state: 'warn', note: '' }, ok('D')])
    ).toEqual({ text: '3 of 4 ok · 1 warning', tone: 'warn' });
    expect(checkSummary([ok('A')])).toEqual({ text: '1 of 1 ok', tone: 'ok' });
  });
});

describe('shownChecks', () => {
  it("adds eva's model list, as a warning when the server did not list it", () => {
    const eva = view({ check: { ...view().check, runtime: 'eva' } });
    expect(shownChecks('eva', eva).at(-1)).toMatchObject({ name: 'Model list', state: 'warn' });
    const listed = { ...eva, models: [{ id: 'a', contextLimit: null, cost: null }] };
    expect(shownChecks('eva', listed).at(-1)).toMatchObject({ state: 'ok' });
    expect(shownChecks('claude', view())).toHaveLength(1);
  });
});

describe('rolesLine and usedBy', () => {
  it('names the roles of a runtime', () => {
    expect(rolesLine('claude', ROLES)).toBe('2 roles: Architect, QA');
    expect(rolesLine('eva', [])).toBe('No roles');
  });

  it("puts roles that name no model on the default, or on the runtime's own", () => {
    expect(usedBy('claude', undefined, undefined, ROLES)).toBe('QA');
    expect(usedBy('claude', 'opus', undefined, ROLES)).toBe('Architect');
    expect(usedBy('claude', 'opus', 'opus', ROLES)).toBe('Architect, QA');
    expect(usedBy('claude', undefined, 'opus', ROLES)).toBe('No roles');
    expect(usedBy('eva', 'qwen/qwen3-coder', undefined, ROLES)).toBe('Builder');
  });
});

describe('modelCost', () => {
  it('is the plan for Claude Code, and price and context for eva', () => {
    const model = { id: 'm', contextLimit: 262_144, cost: { input: 0.3, output: 1.2 } };
    expect(modelCost('claude', model)).toBe('Your plan');
    expect(modelCost('eva', model)).toBe('$0.30 / $1.20 · 262k');
    expect(modelCost('eva', { id: 'm', contextLimit: null, cost: null })).toBe('-');
  });
});

describe('runtimeFacts', () => {
  it('says whether Claude Code is signed in and limited, never who', () => {
    const facts = runtimeFacts('claude', view({ limited: 'at its usage limit until 15:00.' }));
    expect(facts.map((f) => f.value)).toEqual([
      'Signed in with your Claude account',
      'Claude Code is at its usage limit until 15:00. New hires wait.',
      'The normal Claude Code app in a Fleet pane'
    ]);
    expect(runtimeFacts('claude', view({ signedIn: false }))[0].tone).toBe('fail');
  });

  it("gives eva's server, its address and whether a key is set", () => {
    const server = {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: null,
      local: false
    };
    expect(runtimeFacts('eva', view({ server, signedIn: true }))).toEqual([
      { label: 'Model server', value: 'OpenRouter · remote' },
      { label: 'Address', value: 'https://openrouter.ai/api/v1', mono: true },
      { label: 'Key', value: 'Key set in eva', tone: 'ok' }
    ]);
    const local = { ...server, provider: 'llama.cpp', local: true };
    expect(runtimeFacts('eva', view({ server: local, signedIn: false }))[2].value).toBe(
      'No key needed'
    );
    expect(runtimeFacts('eva', view({ server, signedIn: false }))[2].value).toBe('No key in eva');
  });
});
