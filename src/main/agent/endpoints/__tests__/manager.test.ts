import { describe, expect, it, vi } from 'vitest';
import type {
  LocalCatalogEntry,
  LocalEndpointConfig,
  LocalKnownModel,
  LocalEndpointStatus
} from '../../../../shared/agent-endpoints';
import { localModelId } from '../../../../shared/agent-model-id';
import { LocalEndpointManager } from '../manager';
import type { probeEndpoint } from '../probe';

/**
 * What the picker is told about the user's own servers.
 *
 * The behaviour worth protecting here is the one that only shows up over time:
 * a local server is a process on somebody's laptop, so it is off as often as it
 * is on, and the app has to keep telling the truth about a model whose server
 * is not answering right now without either hiding it or claiming it is fine.
 */

const entry = (wireId: string, over: Partial<LocalCatalogEntry> = {}): LocalCatalogEntry => ({
  wireId,
  name: wireId,
  contextLimit: 16384,
  supportsTools: true,
  inputImage: false,
  detail: null,
  ...over
});

const endpoint = (over: Partial<LocalEndpointConfig> = {}): LocalEndpointConfig => ({
  id: 'ep_1',
  baseUrl: 'http://127.0.0.1:11437',
  name: null,
  enabled: true,
  lastKnownModels: [],
  ...over
});

const ok = (models: LocalCatalogEntry[], sleeping = false) =>
  ({ ok: true, fingerprint: 'llamacpp', models, sleeping }) as const;
const fail = (reason: 'refused' | 'timeout' | 'loading' = 'refused') =>
  ({ ok: false, reason, detail: null }) as const;

/** A manager over a fixed endpoint list, with the probe answering to order. */
function harness(
  endpoints: LocalEndpointConfig[],
  answers: Record<string, ReturnType<typeof ok> | ReturnType<typeof fail>>
): {
  manager: LocalEndpointManager;
  remembered: Array<[string, LocalKnownModel[]]>;
  pushed: LocalEndpointStatus[][];
} {
  const remembered: Array<[string, LocalKnownModel[]]> = [];
  const pushed: LocalEndpointStatus[][] = [];
  const probeImpl = vi.fn(async (baseUrl: string) =>
    Promise.resolve(answers[baseUrl] ?? fail())
  ) as unknown as typeof probeEndpoint;

  const manager = new LocalEndpointManager({
    getEndpoints: () => endpoints,
    rememberModels: (id, models) => remembered.push([id, models]),
    onStatusChange: (statuses) => pushed.push(statuses),
    probeImpl
  });
  return { manager, remembered, pushed };
}

describe('LocalEndpointManager', () => {
  it('offers what a reachable endpoint just said it had', async () => {
    const { manager } = harness([endpoint()], {
      'http://127.0.0.1:11437': ok([entry('qwen3-coder')])
    });
    await manager.reload();

    expect(manager.snapshot()).toEqual([
      expect.objectContaining({
        id: localModelId('ep_1', 'qwen3-coder'),
        name: 'qwen3-coder',
        contextLimit: 16384,
        supportsTools: true,
        cost: { input: 0, output: 0 },
        local: { endpointId: 'ep_1', label: '127.0.0.1:11437', reachable: true }
      })
    ]);
  });

  it('writes the roster down so it survives the app being quit', async () => {
    const { manager, remembered } = harness([endpoint()], {
      'http://127.0.0.1:11437': ok([entry('qwen3-coder')])
    });
    await manager.reload();
    expect(remembered).toEqual([['ep_1', [{ wireId: 'qwen3-coder', name: 'qwen3-coder' }]]]);
  });

  /*
   * The reason `lastKnownModels` is persisted at all. Without this the user
   * quits with the server off, reopens, and the model they chose is simply gone
   * from the picker - a setting they had already made, vanished, with nothing
   * on screen to say where it went.
   */
  it('keeps offering a model whose server is not answering, marked as such', async () => {
    const { manager } = harness(
      [endpoint({ lastKnownModels: [{ wireId: 'qwen3-coder', name: 'Qwen3 Coder' }] })],
      { 'http://127.0.0.1:11437': fail() }
    );
    await manager.reload();

    const [model] = manager.snapshot();
    expect(model).toMatchObject({
      id: localModelId('ep_1', 'qwen3-coder'),
      name: 'Qwen3 Coder',
      local: { reachable: false },
      // Kept true so it stays in the coding picker, which filters on it - and
      // being off is exactly when a person needs to see their own selection.
      supportsTools: true,
      // Claimed about nothing else: the last window seen may not be the one it
      // comes back with.
      contextLimit: null
    });
  });

  /*
   * Between launch and the first probe landing there is no result at all.
   * Badging a remembered model offline then would be the app reporting a fault
   * it has not observed - the same reason an unchecked row's dot is grey.
   */
  it('does not call a model offline before anything has been asked', () => {
    const { manager } = harness(
      [endpoint({ lastKnownModels: [{ wireId: 'qwen3-coder', name: 'Qwen3 Coder' }] })],
      { 'http://127.0.0.1:11437': fail() }
    );
    // No reload - exactly the window between startup and the first answer.
    expect(manager.snapshot()).toMatchObject([{ local: { reachable: true } }]);
  });

  /*
   * Switching an endpoint off is the user saying so, which is a different thing
   * from a server being down - that is somebody having closed a terminal.
   */
  it('offers nothing at all from an endpoint that was switched off', async () => {
    const { manager } = harness(
      [
        endpoint({
          enabled: false,
          lastKnownModels: [{ wireId: 'qwen3-coder', name: 'Qwen3 Coder' }]
        })
      ],
      {}
    );
    await manager.reload();
    expect(manager.snapshot()).toEqual([]);
  });

  it('never asks a disabled endpoint anything', async () => {
    const { manager, pushed } = harness([endpoint({ enabled: false })], {});
    await manager.reload();
    expect(pushed.at(-1)).toEqual([expect.objectContaining({ id: 'ep_1', state: 'disabled' })]);
  });

  it('reports an endpoint nobody has asked about yet as unasked, not as broken', () => {
    const { manager } = harness([endpoint()], {});
    expect(manager.statuses()).toEqual([expect.objectContaining({ state: 'unchecked' })]);
  });

  it('names the failure so the row can say which one it was', async () => {
    const { manager } = harness([endpoint()], { 'http://127.0.0.1:11437': fail('loading') });
    await manager.reload();
    expect(manager.statuses()).toEqual([
      expect.objectContaining({ state: 'unreachable', reason: 'loading' })
    ]);
  });

  it('treats a server idling with its weights unloaded as reachable', async () => {
    const { manager } = harness([endpoint()], {
      'http://127.0.0.1:11437': ok([entry('qwen3-coder')], true)
    });
    await manager.reload();
    expect(manager.statuses()).toEqual([expect.objectContaining({ state: 'sleeping' })]);
    expect(manager.snapshot()).toHaveLength(1);
  });

  it('says it is asking before it has an answer', async () => {
    const { manager, pushed } = harness([endpoint()], {
      'http://127.0.0.1:11437': ok([entry('qwen3-coder')])
    });
    await manager.reload();
    expect(pushed[0]).toEqual([expect.objectContaining({ state: 'checking' })]);
    expect(pushed.at(-1)).toEqual([expect.objectContaining({ state: 'ready', modelCount: 1 })]);
  });

  it('keeps two servers apart by the port that is the whole of the difference', async () => {
    const { manager } = harness(
      [endpoint(), endpoint({ id: 'ep_2', baseUrl: 'http://127.0.0.1:11438' })],
      {
        'http://127.0.0.1:11437': ok([entry('model-a')]),
        'http://127.0.0.1:11438': ok([entry('model-b')])
      }
    );
    await manager.reload();

    expect(manager.snapshot().map((m) => [m.id, m.local?.label])).toEqual([
      [localModelId('ep_1', 'model-a'), '127.0.0.1:11437'],
      [localModelId('ep_2', 'model-b'), '127.0.0.1:11438']
    ]);
  });

  it('does not save anything when it is only being asked what an address is', async () => {
    const { manager, remembered } = harness([], {
      'http://127.0.0.1:11437': ok([entry('qwen3-coder')])
    });
    expect(await manager.test('http://127.0.0.1:11437')).toMatchObject({ ok: true });
    expect(remembered).toEqual([]);
    expect(manager.snapshot()).toEqual([]);
  });

  /*
   * Left in rather than filtered out. A machine running two servers that are
   * both already configured would otherwise be reported as "nothing found",
   * which reads as an empty machine; the dialog marks them as already added.
   */
  it('reports an address already set up along with the new ones', async () => {
    const { manager } = harness([endpoint()], {
      'http://127.0.0.1:11437': ok([entry('a')]),
      'http://127.0.0.1:8080': ok([entry('b')])
    });
    const hits = await manager.scan();
    expect(hits.map((h) => h.baseUrl).sort()).toEqual([
      'http://127.0.0.1:11437',
      'http://127.0.0.1:8080'
    ]);
  });

  it('forgets an endpoint that was deleted while it was being asked', async () => {
    const endpoints = [endpoint(), endpoint({ id: 'ep_2', baseUrl: 'http://127.0.0.1:11438' })];
    const { manager } = harness(endpoints, {
      'http://127.0.0.1:11437': ok([entry('model-a')]),
      'http://127.0.0.1:11438': ok([entry('model-b')])
    });
    await manager.reload();
    endpoints.splice(1, 1);
    expect(manager.snapshot().map((m) => m.local?.endpointId)).toEqual(['ep_1']);
  });

  it('has nothing to re-ask about an id that is not there', async () => {
    const { manager } = harness([endpoint()], {});
    expect(await manager.refreshOne('ep_nope')).toBeNull();
  });
});
