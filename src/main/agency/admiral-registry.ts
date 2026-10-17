import type { AdmiralClaimResult } from '../../shared/agency';

type Claim = { paneId: string; owner: number };

/**
 * Which pane is a repository's Admiral. At most one per repository, enforced
 * here in main rather than only in the renderer's layout, so two windows - or
 * a restore racing a click - cannot both open one.
 *
 * In memory on purpose: a claim is held by a live pane, and none survives a
 * restart. Each claim remembers the window (`owner`, its webContents id) that
 * made it, so a window that reloads or closes gives its claims up at once
 * instead of leaving a repository owned by a pane nobody can see.
 */
export class AdmiralRegistry {
  private readonly byRepo = new Map<string, Claim>();

  /**
   * Claim `repoId` for `paneId`. The pane that already holds it may claim it
   * again; any other pane is told who does. A pane holds one repository, so
   * claiming a new one gives up the old.
   */
  claim(input: { repoId: string; paneId: string }, owner: number): AdmiralClaimResult {
    const held = this.byRepo.get(input.repoId);
    if (held && held.paneId !== input.paneId) return { ok: false, ownerPaneId: held.paneId };
    this.release(input.paneId);
    this.byRepo.set(input.repoId, { paneId: input.paneId, owner });
    return { ok: true };
  }

  release(paneId: string): void {
    this.drop((claim) => claim.paneId === paneId);
  }

  /** Give up every claim a window made, when it reloads or goes away. */
  releaseOwner(owner: number): void {
    this.drop((claim) => claim.owner === owner);
  }

  ownerOf(repoId: string): string | null {
    return this.byRepo.get(repoId)?.paneId ?? null;
  }

  private drop(match: (claim: Claim) => boolean): void {
    for (const [repoId, claim] of this.byRepo) {
      if (match(claim)) this.byRepo.delete(repoId);
    }
  }
}
