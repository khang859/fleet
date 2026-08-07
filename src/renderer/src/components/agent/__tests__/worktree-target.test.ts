import { describe, it, expect } from 'vitest';
import { rerootIntoWorktree } from '../worktree-target';

describe('rerootIntoWorktree', () => {
  it('opens at the worktree root when the repo root itself was picked', () => {
    expect(
      rerootIntoWorktree('/home/k/dev/fleet', '/home/k/dev/fleet', '/home/k/.fleet/wt/a')
    ).toBe('/home/k/.fleet/wt/a');
  });

  it('carries a subfolder across', () => {
    expect(
      rerootIntoWorktree('/home/k/dev/fleet/src/main', '/home/k/dev/fleet', '/home/k/.fleet/wt/a')
    ).toBe('/home/k/.fleet/wt/a/src/main');
  });

  it('ignores trailing separators on either side', () => {
    expect(
      rerootIntoWorktree('/home/k/dev/fleet/src/', '/home/k/dev/fleet/', '/home/k/.fleet/wt/a/')
    ).toBe('/home/k/.fleet/wt/a/src');
  });

  it('does not treat a sibling with a shared prefix as a child', () => {
    expect(rerootIntoWorktree('/home/k/dev/fleet-docs', '/home/k/dev/fleet', '/wt/a')).toBe(
      '/wt/a'
    );
  });

  it('falls back to the worktree for a target outside the repo', () => {
    expect(rerootIntoWorktree('/elsewhere/thing', '/home/k/dev/fleet', '/wt/a')).toBe('/wt/a');
  });

  it('keeps a windows path on windows separators', () => {
    expect(rerootIntoWorktree('C:\\dev\\fleet\\src\\main', 'C:\\dev\\fleet', 'C:\\wt\\a')).toBe(
      'C:\\wt\\a\\src\\main'
    );
  });
});
