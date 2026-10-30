import { describe, it, expect } from 'vitest';
import { parseAst } from 'vite';
import { isShimMisplaced } from '../esm-shim-guard';

const SHIM = `
import __cjs_mod__ from 'node:module';
const require = __cjs_mod__.createRequire(import.meta.url);
`;

function check(code: string): boolean {
  return isShimMisplaced(code, parseAst(code));
}

describe('isShimMisplaced', () => {
  it('accepts a shim that is real code', () => {
    expect(check(`import { join } from 'node:path';${SHIM}join('a');`)).toBe(false);
  });

  it('accepts a chunk with no shim', () => {
    expect(check(`import { join } from 'node:path';\njoin('a');`)).toBe(false);
  });

  it('rejects a shim inside a template string', () => {
    const code = `const entry = \`import { join } from 'node:path';${SHIM}\`;\nconsole.log(entry);`;

    expect(check(code)).toBe(true);
  });
});
