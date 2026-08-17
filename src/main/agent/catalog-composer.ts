import type { AgentCatalog } from '../../shared/agent-types';
import type { AgentModelCatalog } from './models-catalog';
import type { LocalEndpointManager } from './endpoints/manager';

/**
 * One list of models, from two places.
 *
 * Every picker in the app - coding, title, classifier, subagent - reads the
 * same catalog and filters it on the same fields. Merging here rather than in
 * each of them is what lets a local model appear in all of them without any of
 * them being changed: what arrives is still `AgentCatalogModel[]`, and the only
 * thing that says where an entry came from is the optional `local` field the
 * rows read to draw a badge.
 *
 * Structurally a stand-in for `AgentModelCatalog` - same `list`, same return -
 * so the IPC handler it sits behind did not have to learn a second source.
 */
export class AgentCatalogComposer {
  constructor(
    private readonly cloud: AgentModelCatalog,
    private readonly local: LocalEndpointManager
  ) {}

  /**
   * The two lists, joined. Local first, because a person who has configured a
   * server of their own is looking for it, and because there are a handful of
   * them against several hundred of the others.
   *
   * `source` and `error` are the cloud list's alone. They describe a download
   * that local models never take part in - a probe reports itself through the
   * endpoint rows instead - and a refresh that failed is still worth saying so
   * even when the picker is full of models from this machine.
   */
  async list(force = false): Promise<AgentCatalog> {
    const cloud = await this.cloud.list(force);
    return { ...cloud, models: [...this.local.snapshot(), ...cloud.models] };
  }
}
