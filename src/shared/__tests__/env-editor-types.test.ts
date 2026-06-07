import { describe, it, expect } from 'vitest';
import {
  EnvFileEntrySchema,
  EnvReadResultSchema,
  EnvWriteResultSchema,
  EnvPathResultSchema,
  EnvTrashResultSchema
} from '../env-editor-types';

const validEntry = {
  absPath: '/repo/.env',
  relPath: '.env',
  group: '·root',
  name: '.env',
  isTemplate: false,
  varCount: 3,
  readable: true
};

describe('env-editor-types', () => {
  it('parses a valid EnvFileEntry', () => {
    expect(EnvFileEntrySchema.parse(validEntry)).toEqual(validEntry);
  });

  it('rejects an EnvFileEntry with a missing field', () => {
    expect(() => EnvFileEntrySchema.parse({ absPath: '/x' })).toThrow();
  });

  it('rejects an EnvFileEntry with a negative varCount', () => {
    expect(() => EnvFileEntrySchema.parse({ ...validEntry, varCount: -1 })).toThrow();
  });

  it('parses read and write results', () => {
    expect(EnvReadResultSchema.parse({ text: 'A=1', mtimeMs: 10 }).text).toBe('A=1');
    const w = EnvWriteResultSchema.parse({ ok: true, mtimeMs: 11 });
    expect(w.ok).toBe(true);
    const ext = EnvWriteResultSchema.parse({ ok: false, externalChange: true, mtimeMs: 12 });
    expect(ext.externalChange).toBe(true);
  });

  it('parses a write result without externalChange', () => {
    const w = EnvWriteResultSchema.parse({ ok: false, mtimeMs: 5 });
    expect(w.externalChange).toBeUndefined();
  });

  it('parses path and trash results', () => {
    expect(EnvPathResultSchema.parse({ absPath: '/x' })).toEqual({ absPath: '/x' });
    expect(EnvTrashResultSchema.parse({ trashPath: '/tmp/x' })).toEqual({ trashPath: '/tmp/x' });
  });
});
