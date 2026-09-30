import { describe, expect, it } from 'vitest';
import { cwdToProjectDir, transcriptPathFor } from '../transcript-path';

describe('cwdToProjectDir', () => {
  it.each([
    ['/home/u/Development/fleet', '-home-u-Development-fleet'],
    ['/home/u/.config/app', '-home-u--config-app'],
    ['/tmp/probe dir_x.y', '-tmp-probe-dir-x-y']
  ])('%s -> %s', (cwd, dir) => {
    expect(cwdToProjectDir(cwd)).toBe(dir);
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
