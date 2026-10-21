import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutId, checkoutRoot, devHomeFor } from '../fleet-home';

describe('devHomeFor', () => {
  it('gives each checkout its own folder under ~/.fleet/dev', () => {
    const one = devHomeFor('/wt/one');
    expect(one).toBe(join(homedir(), '.fleet', 'dev', checkoutId('/wt/one')));
    expect(one).toBe(devHomeFor('/wt/one'));
    expect(one).not.toBe(devHomeFor('/wt/two'));
  });

  it('keeps the folder name short enough for a socket path', () => {
    expect(checkoutId('/a/very/long/worktree/path/that/goes/on')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('checkoutRoot', () => {
  it('finds the nearest folder with a package.json above the code', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-home-'));
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'out', 'main'), { recursive: true });
    expect(checkoutRoot(join(root, 'out', 'main', 'index.mjs'))).toBe(root);
  });

  it('fails when no package.json is above the code', () => {
    expect(() => checkoutRoot(join(tmpdir(), 'nowhere', 'index.mjs'))).toThrow('no package.json');
  });

  it('finds this checkout from its own source', () => {
    expect(checkoutRoot()).toBe(process.cwd());
  });
});
