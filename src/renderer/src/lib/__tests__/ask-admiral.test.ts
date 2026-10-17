import { beforeEach, describe, expect, it, vi } from 'vitest';
import { askAdmiralFrom } from '../ask-admiral';

/** "Ask the Admiral": the request is queued with its page, and dropped when no Admiral opens. */

const runtime = vi.hoisted(() => ({ askAdmiral: vi.fn(), dropAsks: vi.fn() }));
const open = vi.hoisted(() => ({ openAdmiral: vi.fn() }));
vi.mock('../../store/admiral-runtime', () => runtime);
vi.mock('../open-admiral', () => open);

const REPO = { repoId: 'repo-1', root: '/repo', name: 'repo' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('askAdmiralFrom', () => {
  it('queues the request with the page in front and opens the Admiral', async () => {
    open.openAdmiral.mockResolvedValue('opened');
    await expect(
      askAdmiralFrom('Settings › Agency › Admiral', REPO, 'make jobs cheaper')
    ).resolves.toBe('opened');
    expect(runtime.askAdmiral).toHaveBeenCalledWith(
      'repo-1',
      'From Settings › Agency › Admiral: make jobs cheaper'
    );
    expect(open.openAdmiral).toHaveBeenCalledWith('/repo');
    expect(runtime.dropAsks).not.toHaveBeenCalled();
  });

  it('drops the request when the Admiral is refused or fails to open', async () => {
    open.openAdmiral.mockResolvedValueOnce('refused');
    await askAdmiralFrom('Project setup', REPO, 'why?');
    expect(runtime.dropAsks).toHaveBeenCalledWith('repo-1');

    open.openAdmiral.mockRejectedValueOnce(new Error('no lobby'));
    await expect(askAdmiralFrom('Project setup', REPO, 'why?')).rejects.toThrow('no lobby');
    expect(runtime.dropAsks).toHaveBeenCalledTimes(2);
  });
});
