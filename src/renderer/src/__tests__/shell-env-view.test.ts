import { describe, it, expect } from 'vitest';
import {
  isSecret,
  matchesQuery,
  filterVars,
  varsForSection,
  clampSelection,
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

describe('clampSelection', () => {
  it('clamps into [0, length-1]', () => {
    expect(clampSelection(5, 3)).toBe(2);
    expect(clampSelection(1, 3)).toBe(1);
    expect(clampSelection(0, 3)).toBe(0);
  });
  it('returns 0 and never a negative index for an empty list', () => {
    expect(clampSelection(0, 0)).toBe(0);
    expect(clampSelection(1, 0)).toBe(0);
    expect(clampSelection(-1, 0)).toBe(0);
  });
  it('recovers a stale negative selection once rows reappear (regression: stuck at -1)', () => {
    // ArrowDown on an empty filtered list must not produce a negative index...
    expect(clampSelection(0 + 1, 0)).toBe(0);
    // ...and even a stale -1 recovers to 0 when the filter clears to N rows.
    expect(clampSelection(-1, 42)).toBe(0);
  });
});

describe('SECTIONS', () => {
  it('is ordered fleet-builtin, env-sync, login-shell', () => {
    expect(SECTIONS.map((s) => s.source)).toEqual(['fleet-builtin', 'env-sync', 'login-shell']);
  });
});
