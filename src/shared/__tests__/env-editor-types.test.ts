import { describe, it, expect } from 'vitest';
import {
  EnvFileEntrySchema,
  EnvReadResultSchema,
  EnvWriteResultSchema
} from '../env-editor-types';

describe('env-editor-types', () => {
  it('parses a valid EnvFileEntry', () => {
    const entry = {
      absPath: '/repo/.env',
      relPath: '.env',
      group: '·root',
      name: '.env',
      isTemplate: false,
      varCount: 3,
      readable: true
    };
    expect(EnvFileEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects an EnvFileEntry with a missing field', () => {
    expect(() => EnvFileEntrySchema.parse({ absPath: '/x' })).toThrow();
  });

  it('parses read and write results', () => {
    expect(EnvReadResultSchema.parse({ text: 'A=1', mtimeMs: 10 }).text).toBe('A=1');
    const w = EnvWriteResultSchema.parse({ ok: true, mtimeMs: 11 });
    expect(w.ok).toBe(true);
    const ext = EnvWriteResultSchema.parse({ ok: false, externalChange: true, mtimeMs: 12 });
    expect(ext.externalChange).toBe(true);
  });
});
