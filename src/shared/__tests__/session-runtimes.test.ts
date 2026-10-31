import { describe, expect, it } from 'vitest';
import { hasMixedRuntimes, runtimesLabel } from '../session-runtimes';

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

describe('hasMixedRuntimes', () => {
  it('is false when one program or none runs', () => {
    expect(hasMixedRuntimes([])).toBe(false);
    expect(hasMixedRuntimes([{ runtime: 'pi' }, { runtime: 'pi' }])).toBe(false);
  });

  it('is true when two programs run', () => {
    expect(hasMixedRuntimes([{ runtime: 'pi' }, { runtime: 'claude' }])).toBe(true);
  });
});
