import { describe, expect, it } from 'vitest';
import { runtimesLabel } from '../session-runtimes';

describe('runtimesLabel', () => {
  it('names Claude Code when there are no sessions', () => {
    expect(runtimesLabel([])).toBe('Claude Code');
  });

  it('names each program once', () => {
    expect(runtimesLabel([{ runtime: 'pi' }, { runtime: 'pi' }])).toBe('Pi');
    expect(runtimesLabel([{ runtime: 'pi' }, { runtime: 'claude' }, { runtime: 'eva' }])).toBe(
      'Claude Code · eva · Pi'
    );
  });
});
