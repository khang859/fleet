import { describe, it, expect, vi } from 'vitest';
import { registerAnnotateModalOpener, openAnnotateModal } from '../annotate-modal-bridge';

describe('annotate-modal-bridge', () => {
  it('calls registered opener', () => {
    const opener = vi.fn();
    const cleanup = registerAnnotateModalOpener(opener);
    openAnnotateModal();
    expect(opener).toHaveBeenCalledOnce();
    cleanup();
  });

  it('does nothing when no opener registered', () => {
    // Should not throw
    openAnnotateModal();
  });

  it('stops calling after cleanup', () => {
    const opener = vi.fn();
    const cleanup = registerAnnotateModalOpener(opener);
    cleanup();
    openAnnotateModal();
    expect(opener).not.toHaveBeenCalled();
  });

  it('replaces previous opener', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerAnnotateModalOpener(first);
    const cleanup = registerAnnotateModalOpener(second);
    openAnnotateModal();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    cleanup();
  });
});
