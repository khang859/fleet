/**
 * Rejects out-of-order or duplicate state reports from external hook sources.
 * Each (paneId, source) tuple tracks the highest seq seen so far.
 */
export class SeqTracker {
  private readonly seqs = new Map<string, bigint | null>();

  private key(paneId: string, source: string): string {
    return `${paneId} ${source}`;
  }

  accept(paneId: string, source: string, seq: bigint | undefined): boolean {
    const k = this.key(paneId, source);
    const last = this.seqs.get(k);
    if (seq === undefined) {
      if (last !== undefined) return false;
      this.seqs.set(k, null);
      return true;
    }
    if (last !== undefined && last !== null && last >= seq) return false;
    this.seqs.set(k, seq);
    return true;
  }

  reset(paneId: string): void {
    const prefix = `${paneId} `;
    for (const k of this.seqs.keys()) {
      if (k.startsWith(prefix)) this.seqs.delete(k);
    }
  }
}
