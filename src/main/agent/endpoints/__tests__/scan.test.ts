import { describe, expect, it, vi } from 'vitest';
import { COMMON_LOCAL_PORTS } from '../../../../shared/agent-endpoints';
import type { probeEndpoint } from '../probe';
import { scanLocalPorts } from '../scan';

/**
 * Looking for servers the user already started. A convenience over a fixed
 * handful of loopback ports, not a discovery mechanism - so the interesting
 * questions are what it leaves out and how long it takes.
 */

const model = {
  wireId: 'm',
  name: 'm',
  contextLimit: null,
  supportsTools: true,
  inputImage: false,
  detail: null
};

/** A probe that succeeds only at the given addresses. */
const probing = (found: Record<string, boolean>): typeof probeEndpoint =>
  vi.fn(async (baseUrl: string) =>
    Promise.resolve(
      found[baseUrl]
        ? { ok: true as const, fingerprint: 'llamacpp' as const, models: [model], sleeping: false }
        : { ok: false as const, reason: 'refused' as const, detail: null }
    )
  ) as unknown as typeof probeEndpoint;

describe('scanLocalPorts', () => {
  it('offers the addresses that answered and nothing else', async () => {
    const hits = await scanLocalPorts({
      probe: probing({ 'http://127.0.0.1:11437': true, 'http://127.0.0.1:8080': true })
    });
    expect(hits.map((h) => h.baseUrl).sort()).toEqual([
      'http://127.0.0.1:11437',
      'http://127.0.0.1:8080'
    ]);
  });

  /*
   * Including the ones already configured. A machine running two servers that
   * are both already set up must not be answered with "nothing found" - the
   * dialog marks them as already added rather than leaving them out.
   */
  it('offers an address that is already set up, for the caller to mark', async () => {
    const hits = await scanLocalPorts({
      probe: probing({ 'http://127.0.0.1:11437': true, 'http://127.0.0.1:8080': true })
    });
    expect(hits.map((h) => h.baseUrl)).toContain('http://127.0.0.1:11437');
  });

  /*
   * A port that answered with a failure is either not one of these at all or is
   * mid-load, and neither belongs in a list headed "found".
   */
  it('finds nothing on a machine running none of these', async () => {
    expect(await scanLocalPorts({ probe: probing({}) })).toEqual([]);
  });

  it('tries every port on the list, and only those', async () => {
    const probe = probing({});
    await scanLocalPorts({ probe });
    const asked = (probe as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(asked.sort()).toEqual(COMMON_LOCAL_PORTS.map((p) => `http://127.0.0.1:${p}`).sort());
  });

  /*
   * All at once rather than one after another. Serially this is the timeout
   * times the number of dead ports, and on a machine running nothing that is
   * every port on the list - fifteen seconds of spinner to report nothing.
   */
  it('asks every port at the same time', async () => {
    let live = 0;
    let peak = 0;
    const probe = (async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return { ok: false, reason: 'refused', detail: null } as const;
    }) as unknown as typeof probeEndpoint;

    await scanLocalPorts({ probe });
    expect(peak).toBe(COMMON_LOCAL_PORTS.length);
  });
});
