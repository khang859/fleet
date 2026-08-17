import type { AgentCatalogModel } from '../../../shared/agent-types';
import {
  endpointLabel,
  type EndpointProbeResult,
  type LocalEndpointConfig,
  type LocalEndpointScanHit,
  type LocalKnownModel,
  type LocalEndpointStatus
} from '../../../shared/agent-endpoints';
import { hostPort } from '../../../shared/agent-endpoint-url';
import { localModelId } from '../../../shared/agent-model-id';
import { probeEndpoint } from './probe';
import { scanLocalPorts } from './scan';

/**
 * What the user's own servers are currently offering.
 *
 * Holds no connections - a completions endpoint is stateless HTTP called once
 * per turn, not a session to keep alive - so this is a cache of the last answer
 * each address gave, and nothing more. It is deliberately not on a timer: a
 * server going up or down while nobody is looking is not something to poll for,
 * and the user has a Test button for the moment they care.
 */

export type EndpointManagerDeps = {
  getEndpoints: () => LocalEndpointConfig[];
  /**
   * Writes a successful probe's roster back into settings.
   *
   * The one piece of probe output that persists, so that a model chosen from a
   * server that is currently off is still in the picker after a restart.
   */
  rememberModels: (endpointId: string, models: LocalKnownModel[]) => void;
  onStatusChange?: (statuses: LocalEndpointStatus[]) => void;
  fetchImpl?: typeof fetch;
  probeImpl?: typeof probeEndpoint;
};

export class LocalEndpointManager {
  /** The last probe result per endpoint id. Memory only, never written down. */
  private results = new Map<string, EndpointProbeResult>();
  private checking = new Set<string>();

  constructor(private readonly deps: EndpointManagerDeps) {}

  private get probe(): typeof probeEndpoint {
    return this.deps.probeImpl ?? probeEndpoint;
  }

  /** Ask every enabled endpoint what it has, all at once. */
  async reload(): Promise<void> {
    const endpoints = this.deps.getEndpoints();
    const enabled = endpoints.filter((endpoint) => endpoint.enabled);
    for (const endpoint of enabled) this.checking.add(endpoint.id);
    this.announce();

    await Promise.all(enabled.map(async (endpoint) => this.refresh(endpoint)));

    // Anything deleted while this ran has no business keeping a result.
    const live = new Set(endpoints.map((endpoint) => endpoint.id));
    for (const id of [...this.results.keys()]) if (!live.has(id)) this.results.delete(id);
    this.announce();
  }

  /** One endpoint, by id. Returns what it found, and remembers it. */
  async refreshOne(id: string): Promise<EndpointProbeResult | null> {
    const endpoint = this.deps.getEndpoints().find((e) => e.id === id);
    if (endpoint === undefined) return null;
    this.checking.add(id);
    this.announce();
    const result = await this.refresh(endpoint);
    this.announce();
    return result;
  }

  private async refresh(endpoint: LocalEndpointConfig): Promise<EndpointProbeResult> {
    const result = await this.probe(endpoint.baseUrl, { fetchImpl: this.deps.fetchImpl });
    this.results.set(endpoint.id, result);
    this.checking.delete(endpoint.id);
    if (result.ok) {
      this.deps.rememberModels(
        endpoint.id,
        result.models.map((model) => ({ wireId: model.wireId, name: model.name }))
      );
    }
    return result;
  }

  /**
   * Ask an address what it is, without saving anything.
   *
   * What the Test button in the add form calls, which is why it takes a URL
   * rather than an id: at that point there is nothing saved to have an id.
   */
  async test(baseUrl: string): Promise<EndpointProbeResult> {
    return this.probe(baseUrl, { fetchImpl: this.deps.fetchImpl });
  }

  /** Look for servers the user has running but has not told Fleet about. */
  async scan(): Promise<LocalEndpointScanHit[]> {
    // Everything found, including the addresses already configured. Leaving
    // those out would answer a machine running two servers, both already added,
    // with "nothing found" - which reads as "there is nothing here" rather than
    // as "you have them all". The dialog marks them as already added instead.
    return scanLocalPorts({ fetchImpl: this.deps.fetchImpl, probe: this.probe });
  }

  statuses(): LocalEndpointStatus[] {
    return this.deps.getEndpoints().map((endpoint) => this.statusOf(endpoint));
  }

  private statusOf(endpoint: LocalEndpointConfig): LocalEndpointStatus {
    const base = { id: endpoint.id, detail: null, reason: null };
    if (!endpoint.enabled) {
      return { ...base, state: 'disabled', fingerprint: null, modelCount: 0 };
    }
    if (this.checking.has(endpoint.id)) {
      return { ...base, state: 'checking', fingerprint: null, modelCount: 0 };
    }
    const result = this.results.get(endpoint.id);
    if (result === undefined) {
      // Never asked. Distinct from unreachable on purpose - an endpoint nobody
      // has tested yet has not failed at anything, and colouring it as an error
      // would be the app inventing a fault to report.
      return {
        ...base,
        state: 'unchecked',
        fingerprint: null,
        modelCount: endpoint.lastKnownModels.length
      };
    }
    if (!result.ok) {
      return {
        ...base,
        state: 'unreachable',
        fingerprint: null,
        modelCount: endpoint.lastKnownModels.length,
        reason: result.reason,
        detail: result.detail
      };
    }
    return {
      ...base,
      state: result.sleeping ? 'sleeping' : 'ready',
      fingerprint: result.fingerprint,
      modelCount: result.models.length
    };
  }

  /**
   * Every local model, in the shape the picker already speaks.
   *
   * The fallback is the substance of this method. An endpoint that answered
   * contributes what it just said; one that did not contributes what it said
   * last time, marked unreachable if it was asked and failed. A disabled
   * endpoint contributes nothing,
   * because switching it off is the user saying so - unlike a server being
   * down, which is the user having closed a terminal.
   */
  snapshot(): AgentCatalogModel[] {
    const models: AgentCatalogModel[] = [];
    for (const endpoint of this.deps.getEndpoints()) {
      if (!endpoint.enabled) continue;
      const label = endpointLabel(endpoint, hostPort(endpoint.baseUrl));
      const result = this.results.get(endpoint.id);

      if (result?.ok === true) {
        for (const model of result.models) {
          models.push(
            toCatalogModel({
              endpointId: endpoint.id,
              label,
              reachable: true,
              wireId: model.wireId,
              name: model.name,
              contextLimit: model.contextLimit,
              supportsTools: model.supportsTools,
              inputImage: model.inputImage,
              detail: model.detail
            })
          );
        }
        continue;
      }

      for (const model of endpoint.lastKnownModels) {
        models.push(
          toCatalogModel({
            endpointId: endpoint.id,
            label,
            // Only a probe that came back badly earns the offline mark. Between
            // launch and the first one landing there is no result at all, and
            // badging a model offline then would be the app reporting a fault
            // it has not observed - the same reason an unchecked row's dot is
            // grey rather than amber.
            reachable: result === undefined,
            wireId: model.wireId,
            name: model.name,
            // Nothing is claimed about a server that is not answering. The
            // context window is the one number worth being honest about, and
            // the last one seen may not be the one it comes back with.
            contextLimit: null,
            // Kept true so the model stays in the coding picker while its
            // server is off - which is exactly when a person needs to see that
            // it is still their selection.
            supportsTools: true,
            inputImage: false,
            detail: null
          })
        );
      }
    }
    return models;
  }

  private announce(): void {
    this.deps.onStatusChange?.(this.statuses());
  }
}

/** One local model, dressed as a catalog entry so no picker has to know. */
function toCatalogModel(input: {
  endpointId: string;
  label: string;
  reachable: boolean;
  wireId: string;
  name: string;
  contextLimit: number | null;
  supportsTools: boolean;
  inputImage: boolean;
  detail: string | null;
}): AgentCatalogModel {
  return {
    id: localModelId(input.endpointId, input.wireId),
    name: input.name,
    description: input.detail,
    contextLimit: input.contextLimit,
    // Never published by any of these servers. Left null so the max-tokens
    // slider stays unclamped rather than clamped to a number we invented.
    outputLimit: null,
    supportsTools: input.supportsTools,
    // Every one of these takes it; none of them says so.
    supportsTemperature: true,
    inputImage: input.inputImage,
    outputImage: false,
    // Empty rather than guessed. A local model may well think - and if it does,
    // its own template decides - but none of these servers publishes a
    // reasoning taxonomy that maps onto the controls the panel draws, and a
    // slider that sends a parameter the server ignores is worse than no slider.
    reasoning: [],
    // Not "unknown". A model running on the user's own hardware is free, and
    // the spend meter should say nothing rather than nothing-in-particular.
    cost: { input: 0, output: 0 },
    releaseDate: null,
    defaultTemperature: null,
    defaultReasoningEnabled: null,
    defaultReasoningEffort: null,
    local: { endpointId: input.endpointId, label: input.label, reachable: input.reachable }
  };
}
