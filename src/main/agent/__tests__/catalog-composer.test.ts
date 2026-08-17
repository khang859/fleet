import { describe, expect, it, vi } from 'vitest';
import type { AgentCatalog, AgentCatalogModel } from '../../../shared/agent-types';
import { AgentCatalogComposer } from '../catalog-composer';
import type { AgentModelCatalog } from '../models-catalog';
import type { LocalEndpointManager } from '../endpoints/manager';

/**
 * Two sources, one list.
 *
 * Every picker in the app reads the same catalog and filters it on the same
 * fields, so merging here is what lets a local model appear in all of them
 * without any of them being changed. What is checked below is that the merge is
 * exactly that and nothing more: the cloud half arrives unaltered, and the
 * local half is ordinary catalog entries by the time anyone sees them.
 */

const cloudModel = (id: string): AgentCatalogModel =>
  ({ id, name: id, supportsTools: true }) as AgentCatalogModel;

const localModel = (id: string): AgentCatalogModel =>
  ({
    id,
    name: id,
    supportsTools: true,
    local: { endpointId: 'ep_1', label: '127.0.0.1:11437', reachable: true }
  }) as AgentCatalogModel;

function composer(
  cloud: Partial<AgentCatalog>,
  local: AgentCatalogModel[]
): { subject: AgentCatalogComposer; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () =>
    Promise.resolve({
      models: [],
      imageModels: [],
      fetchedAt: 1,
      source: 'cache',
      error: null,
      ...cloud
    } as AgentCatalog)
  );
  return {
    subject: new AgentCatalogComposer(
      { list } as unknown as AgentModelCatalog,
      {
        snapshot: () => local
      } as unknown as LocalEndpointManager
    ),
    list
  };
}

describe('AgentCatalogComposer', () => {
  it('puts the models on this machine first, ahead of the several hundred others', async () => {
    const { subject } = composer({ models: [cloudModel('anthropic/claude-sonnet-4.5')] }, [
      localModel('local:ep_1/qwen3-coder')
    ]);
    const { models } = await subject.list();
    expect(models.map((m) => m.id)).toEqual([
      'local:ep_1/qwen3-coder',
      'anthropic/claude-sonnet-4.5'
    ]);
  });

  it('is the cloud catalog exactly when there are no local servers', async () => {
    const { subject } = composer({ models: [cloudModel('openai/gpt-5.6')] }, []);
    const catalog = await subject.list();
    expect(catalog).toEqual({
      models: [cloudModel('openai/gpt-5.6')],
      imageModels: [],
      fetchedAt: 1,
      source: 'cache',
      error: null
    });
  });

  /*
   * The case this feature exists for: no key, no network, and a picker that is
   * still full. A refresh that failed is reported all the same, because it is
   * true and because the cloud half of the list really is missing.
   */
  it('still has the local models when the download failed outright', async () => {
    const { subject } = composer(
      { models: [], source: 'none', error: 'models.dev responded 503', fetchedAt: 0 },
      [localModel('local:ep_1/qwen3-coder')]
    );
    const catalog = await subject.list();
    expect(catalog.models.map((m) => m.id)).toEqual(['local:ep_1/qwen3-coder']);
    expect(catalog.error).toBe('models.dev responded 503');
  });

  it('passes a forced refresh through to the download it is a refresh of', async () => {
    const { subject, list } = composer({}, []);
    await subject.list(true);
    expect(list).toHaveBeenCalledWith(true);
    await subject.list();
    expect(list).toHaveBeenLastCalledWith(false);
  });

  it('asks the endpoints again on every call, so a server coming up shows up', async () => {
    let models: AgentCatalogModel[] = [];
    const subject = new AgentCatalogComposer(
      {
        list: async () =>
          Promise.resolve({
            models: [],
            imageModels: [],
            fetchedAt: 1,
            source: 'cache',
            error: null
          } as AgentCatalog)
      } as unknown as AgentModelCatalog,
      { snapshot: () => models } as unknown as LocalEndpointManager
    );

    expect((await subject.list()).models).toEqual([]);
    models = [localModel('local:ep_1/qwen3-coder')];
    expect((await subject.list()).models).toHaveLength(1);
  });
});
