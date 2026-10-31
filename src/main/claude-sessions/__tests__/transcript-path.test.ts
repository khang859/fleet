import { describe, expect, it } from 'vitest';
import { cwdToProjectDir, sessionFilePath, transcriptPathFor } from '../transcript-path';

describe('cwdToProjectDir', () => {
  it.each([
    ['/home/u/Development/fleet', '-home-u-Development-fleet'],
    ['/home/u/.config/app', '-home-u--config-app'],
    ['/tmp/probe dir_x.y', '-tmp-probe-dir-x-y']
  ])('%s -> %s', (cwd, dir) => {
    expect(cwdToProjectDir(cwd)).toBe(dir);
  });
});

describe('sessionFilePath', () => {
  const session = { sessionId: 's1', cwd: '/repo', transcriptPath: null, configDir: null };

  it('works out a Claude Code path', () => {
    expect(sessionFilePath({ ...session, runtime: 'claude' }, '/home/u')).toBe(
      '/home/u/.claude/projects/-repo/s1.jsonl'
    );
  });

  it('uses only the path Pi reported, because its name holds a time', () => {
    expect(sessionFilePath({ ...session, runtime: 'pi' })).toBeNull();
    expect(sessionFilePath({ ...session, runtime: 'pi', transcriptPath: '/x/t_s1.jsonl' })).toBe(
      '/x/t_s1.jsonl'
    );
  });

  it('has none for eva', () => {
    expect(sessionFilePath({ ...session, runtime: 'eva', transcriptPath: '/x' })).toBeNull();
  });
});

describe('transcriptPathFor', () => {
  const session = { sessionId: 's1', cwd: '/repo/my app', transcriptPath: null, configDir: null };

  it('uses the path Claude reported', () => {
    expect(transcriptPathFor({ ...session, transcriptPath: '/x/s1.jsonl' }, '/home/u')).toBe(
      '/x/s1.jsonl'
    );
  });

  it('falls back to the session config folder, then to ~/.claude', () => {
    expect(transcriptPathFor({ ...session, configDir: '/c' }, '/home/u')).toBe(
      '/c/projects/-repo-my-app/s1.jsonl'
    );
    expect(transcriptPathFor(session, '/home/u')).toBe(
      '/home/u/.claude/projects/-repo-my-app/s1.jsonl'
    );
  });
});
