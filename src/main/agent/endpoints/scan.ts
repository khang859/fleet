import {
  COMMON_LOCAL_PORTS,
  SCAN_TIMEOUT_MS,
  type LocalEndpointScanHit
} from '../../../shared/agent-endpoints';
import { probeEndpoint } from './probe';

/**
 * Looking for servers the user has already started.
 *
 * A convenience rather than a discovery mechanism: a fixed handful of ports on
 * loopback, tried once, when the user asks. It is not a port scanner and does
 * not pretend to be one - somebody serving on an unusual port types the address
 * instead, and the empty result says as much.
 */
export async function scanLocalPorts(
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    ports?: readonly number[];
    probe?: typeof probeEndpoint;
  } = {}
): Promise<LocalEndpointScanHit[]> {
  const probe = opts.probe ?? probeEndpoint;
  const ports = opts.ports ?? COMMON_LOCAL_PORTS;

  // All at once. Serially this would take the timeout times the number of dead
  // ports, and on a machine running nothing that is the whole list.
  const results = await Promise.all(
    ports.map(async (port): Promise<LocalEndpointScanHit | null> => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const result = await probe(baseUrl, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs ?? SCAN_TIMEOUT_MS
      });
      // Only servers that are ready are offered. A port that answered with a
      // failure is either not one of these at all or is mid-load, and neither
      // is something to put in a list headed "found".
      if (!result.ok) return null;
      return { baseUrl, fingerprint: result.fingerprint, models: result.models };
    })
  );

  return results.filter((hit): hit is LocalEndpointScanHit => hit !== null);
}
