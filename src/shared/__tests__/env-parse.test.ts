import { describe, it, expect } from 'vitest';
import {
  parseEnvFile,
  serializeEnvFile,
  formatVarLine,
  updateVarLine,
  newVarLine,
  countVars
} from '../env-parse';

const SAMPLE = `# Database
DATABASE_URL=postgres://localhost:5432/app

export API_KEY="sk_live_3f9a"
PORT=3000
EMPTY=
`;

describe('env-parse', () => {
  it('round-trips text byte-for-byte when unedited', () => {
    const parsed = parseEnvFile(SAMPLE);
    expect(serializeEnvFile(parsed)).toBe(SAMPLE);
  });

  it('classifies lines', () => {
    const { lines } = parseEnvFile(SAMPLE);
    expect(lines[0]).toMatchObject({ kind: 'comment' });
    expect(lines[1]).toMatchObject({ kind: 'var', key: 'DATABASE_URL' });
    expect(lines[2]).toMatchObject({ kind: 'blank' });
    expect(lines[3]).toMatchObject({ kind: 'var', key: 'API_KEY', value: 'sk_live_3f9a' });
    expect(lines[5]).toMatchObject({ kind: 'var', key: 'EMPTY', value: '' });
  });

  it('preserves comments and ordering when one value changes', () => {
    const parsed = parseEnvFile(SAMPLE);
    const idx = parsed.lines.findIndex((l) => l.kind === 'var' && l.key === 'PORT');
    const portLine = parsed.lines[idx];
    if (portLine.kind !== 'var') throw new Error('expected PORT var line');
    parsed.lines[idx] = updateVarLine(portLine, 'PORT', '4000');
    const out = serializeEnvFile(parsed);
    expect(out).toContain('# Database');
    expect(out).toContain('PORT=4000');
    expect(out).toContain('export API_KEY="sk_live_3f9a"'); // untouched line preserved verbatim
  });

  it('quotes values with spaces or # and keeps the export prefix', () => {
    expect(formatVarLine('K', 'a b')).toBe('K="a b"');
    expect(formatVarLine('K', 'a#b')).toBe('K="a#b"');
    expect(formatVarLine('K', 'plain')).toBe('K=plain');
    expect(formatVarLine('K', 'x', 'export K=old')).toBe('export K=x');
  });

  it('creates a new var line', () => {
    expect(newVarLine('NEW', 'v')).toMatchObject({ kind: 'var', key: 'NEW', value: 'v', raw: 'NEW=v' });
  });

  it('formatVarLine combines export prefix with quoting', () => {
    expect(formatVarLine('K', 'a b', 'export K=old')).toBe('export K="a b"');
  });

  it('countVars counts only var lines', () => {
    expect(countVars(SAMPLE)).toBe(4);
  });
});
