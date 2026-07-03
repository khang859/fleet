import { describe, it, expect } from 'vitest';
import {
  isSecret,
  matchesQuery,
  filterVars,
  varsForSection,
  SECTIONS
} from '../components/shell-env/shell-env-view';
import type { ShellEnvVar } from '../../../shared/shell-env-types';

const v = (key: string, value: string, source: ShellEnvVar['source']): ShellEnvVar => ({
  key,
  value,
  source
});

describe('isSecret', () => {
  it('masks secret-looking keys case-insensitively', () => {
    expect(isSecret(v('API_TOKEN', 'x', 'login-shell'))).toBe(true);
    expect(isSecret(v('aws_secret_access_key', 'x', 'login-shell'))).toBe(true);
    expect(isSecret(v('PASSWORD', 'x', 'login-shell'))).toBe(true);
    expect(isSecret(v('PATH', '/bin', 'login-shell'))).toBe(false);
  });
  it('masks all env-sync vars regardless of key', () => {
    expect(isSecret(v('PLAIN', 'x', 'env-sync'))).toBe(true);
  });
});

describe('matchesQuery / filterVars', () => {
  it('matches key or value, case-insensitive; empty query matches all', () => {
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), 'fo')).toBe(true);
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), 'BAR')).toBe(true);
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), 'zzz')).toBe(false);
    expect(matchesQuery(v('FOO', 'bar', 'login-shell'), '')).toBe(true);
  });
  it('filterVars keeps only matching', () => {
    const vars = [v('A', '1', 'login-shell'), v('B', '2', 'login-shell')];
    expect(filterVars(vars, 'A').map((x) => x.key)).toEqual(['A']);
  });
});

describe('varsForSection', () => {
  it('returns only vars of the given source', () => {
    const vars = [v('A', '1', 'env-sync'), v('B', '2', 'login-shell')];
    expect(varsForSection(vars, 'env-sync').map((x) => x.key)).toEqual(['A']);
  });
});

describe('SECTIONS', () => {
  it('is ordered fleet-builtin, env-sync, login-shell', () => {
    expect(SECTIONS.map((s) => s.source)).toEqual(['fleet-builtin', 'env-sync', 'login-shell']);
  });
});
