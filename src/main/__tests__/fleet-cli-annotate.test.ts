// src/main/__tests__/fleet-cli-annotate.test.ts
import { describe, it, expect } from 'vitest';
import { getHelpText } from '../fleet-cli';

describe('fleet annotate CLI', () => {
  describe('getHelpText', () => {
    it('returns annotate help text', () => {
      const help = getHelpText(['annotate', '--help']);
      expect(help).toContain('fleet annotate');
      expect(help).toContain('annotation');
    });

    it('includes annotate in top-level help', () => {
      const help = getHelpText(['--help']);
      expect(help).toContain('annotate');
    });
  });
});
