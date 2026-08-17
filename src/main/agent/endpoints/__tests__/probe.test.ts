import { describe, expect, it } from 'vitest';
import {
  classifyFetchError,
  displayName,
  probeEndpoint,
  resolveContextLimit,
  toCatalogEntries
} from '../probe';

/**
 * Asking a real server what it is.
 *
 * The two payloads below are verbatim from a `llama-server` build b10431 on
 * this machine, trimmed of the fields nothing reads. They are copied rather
 * than invented because the whole value of this probe is that it matches what
 * these servers actually send, and a hand-written fixture would only ever
 * confirm what the parser already assumed.
 */

/** llama.cpp's `/v1/models`. Note `n_ctx` and `n_ctx_train` disagreeing 16x. */
const LLAMACPP_MODELS = {
  object: 'list',
  data: [
    {
      id: 'ornith-abl-vision',
      object: 'model',
      created: 1786986598,
      owned_by: 'llamacpp',
      meta: {
        vocab_type: 2,
        n_vocab: 248320,
        n_ctx: 16384,
        n_ctx_train: 262144,
        n_embd: 2048,
        n_params: 34660610688,
        size: 21480950272,
        ftype: 'Q4_K - Medium'
      }
    }
  ]
};

/** llama.cpp's `/props`, which no other server has. */
const LLAMACPP_PROPS = {
  model_alias: 'ornith-abl-vision',
  model_path: '/home/knguyen/models/ornith-abl-vision/Ornith-35B-Abliterated-Q4_K_M.gguf',
  modalities: { vision: true, video: true, audio: false },
  chat_template_caps: { supports_tools: true, supports_parallel_tool_calls: true },
  build_info: 'b10431-1692f9e50',
  is_sleeping: false,
  default_generation_settings: { n_ctx: 16384 }
};

/** A fetch that answers per path, and 404s anything it was not given. */
type Route = { status?: number; body?: unknown };

function serving(routes: Record<string, Route>): typeof fetch {
  const table = new Map(Object.entries(routes));
  return (async (url: string) => {
    const route = table.get(new URL(url).pathname);
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(
      new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
  }) as unknown as typeof fetch;
}

/** A fetch that fails the way a closed port and a dead host each do. */
function throwing(name: string): typeof fetch {
  return (async () => {
    const err = new Error('nope');
    err.name = name;
    return Promise.reject(err);
  }) as unknown as typeof fetch;
}

describe('resolveContextLimit', () => {
  /*
   * The bug this function exists for. A model trained at 262144 and served at
   * 16384 is an ordinary way to run one on a single card, and reading the
   * trained figure would let a conversation grow sixteen times past the window
   * before failing - mid-turn, after the tokens had been spent.
   */
  it('reads what the server allocated, never what the model was trained for', () => {
    expect(
      resolveContextLimit({ id: 'm', meta: { n_ctx: 16384, n_ctx_train: 262144 } }, null)
    ).toBe(16384);
  });

  it('prefers what /props reports over the models list', () => {
    expect(
      resolveContextLimit(
        { id: 'm', meta: { n_ctx: 8192, n_ctx_train: 262144 } },
        { default_generation_settings: { n_ctx: 16384 } }
      )
    ).toBe(16384);
  });

  it('reads the field each other server states it in', () => {
    expect(resolveContextLimit({ id: 'm', max_model_len: 32768 }, null)).toBe(32768);
    expect(resolveContextLimit({ id: 'm', loaded_context_length: 4096 }, null)).toBe(4096);
    expect(resolveContextLimit({ id: 'm', max_context_length: 8192 }, null)).toBe(8192);
  });

  /*
   * Last rather than never: a number that is too large still draws a meter, and
   * a meter that is wrong in the generous direction beats no meter at all when
   * the alternative is a server that published nothing else.
   */
  it('falls back to the trained figure only when there is nothing else', () => {
    expect(resolveContextLimit({ id: 'm', meta: { n_ctx_train: 262144 } }, null)).toBe(262144);
  });

  it('answers null rather than guessing when the server said nothing', () => {
    expect(resolveContextLimit({ id: 'm' }, null)).toBeNull();
  });

  /*
   * A server with nothing loaded reports zero rather than omitting the field,
   * and a router listing its whole roster does it for every model it has not
   * loaded. Zero is the absence of an answer, not a window of nothing - taken
   * literally it would have the app budget a conversation against no room at
   * all.
   */
  it('reads a reported zero as no answer, and keeps looking', () => {
    expect(resolveContextLimit({ id: 'm', meta: { n_ctx: 0, n_ctx_train: 262144 } }, null)).toBe(
      262144
    );
    expect(
      resolveContextLimit(
        { id: 'm', meta: { n_ctx: 16384 } },
        {
          default_generation_settings: { n_ctx: 0 }
        }
      )
    ).toBe(16384);
    expect(resolveContextLimit({ id: 'm', max_model_len: 0 }, null)).toBeNull();
  });
});

describe('displayName', () => {
  it('leaves an alias alone', () => {
    expect(displayName('qwen3-coder')).toBe('qwen3-coder');
  });

  /*
   * A server started without `--alias` names the model after the file, which is
   * a path that is both enormous and mostly identical to every other model the
   * person has.
   */
  it('takes the file out of a path a server used as an id', () => {
    expect(displayName('/models/gguf/Qwen3-Coder-30B-Q4_K_M.gguf')).toBe('Qwen3-Coder-30B-Q4_K_M');
    expect(displayName('C:\\models\\Qwen3.gguf')).toBe('Qwen3');
  });
});

describe('toCatalogEntries', () => {
  /*
   * The coding-model picker lists only models that call tools, so a pessimistic
   * default would hide the user's own server from the one role they added it
   * for, with nothing on screen to explain the absence.
   */
  it('assumes tools when the server does not say, so the model stays pickable', () => {
    const [entry] = toCatalogEntries([{ id: 'mystery-model' }], null);
    expect(entry.supportsTools).toBe(true);
    expect(entry.inputImage).toBe(false);
  });

  it('believes llama.cpp when it does say', () => {
    const [entry] = toCatalogEntries(LLAMACPP_MODELS.data, {
      ...LLAMACPP_PROPS,
      chat_template_caps: { supports_tools: false }
    });
    expect(entry.supportsTools).toBe(false);
  });

  it('skips an entry it cannot read rather than losing the whole endpoint', () => {
    const entries = toCatalogEntries([{ id: 'good' }, { nope: true }, 'string'], null);
    expect(entries.map((e) => e.wireId)).toEqual(['good']);
  });
});

describe('classifyFetchError', () => {
  it('tells a port with nothing on it from one that never answered', () => {
    expect(classifyFetchError(Object.assign(new Error(''), { name: 'TypeError' }))).toBe('refused');
    expect(classifyFetchError(Object.assign(new Error(''), { name: 'TimeoutError' }))).toBe(
      'timeout'
    );
  });
});

describe('probeEndpoint', () => {
  it('reads a llama-server from both of its endpoints', async () => {
    const result = await probeEndpoint('http://127.0.0.1:11437', {
      fetchImpl: serving({
        '/v1/models': { body: LLAMACPP_MODELS },
        '/props': { body: LLAMACPP_PROPS }
      })
    });

    expect(result).toEqual({
      ok: true,
      fingerprint: 'llamacpp',
      sleeping: false,
      models: [
        {
          wireId: 'ornith-abl-vision',
          name: 'ornith-abl-vision',
          contextLimit: 16384,
          supportsTools: true,
          inputImage: true,
          detail: 'Q4_K - Medium · b10431-1692f9e50'
        }
      ]
    });
  });

  /*
   * Everything that is not llama.cpp 404s `/props`, and is none the worse for
   * it: the models list is what decides whether this is a server we can use.
   */
  it('reads a server that has only the endpoint every one of them has', async () => {
    const result = await probeEndpoint('http://127.0.0.1:1234', {
      fetchImpl: serving({
        '/v1/models': { body: { object: 'list', data: [{ id: 'llama-3.3-70b' }] } }
      })
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toBe('generic');
    expect(result.models[0]).toMatchObject({ wireId: 'llama-3.3-70b', contextLimit: null });
  });

  it('reports a server idling with its weights unloaded, which is not a fault', async () => {
    const result = await probeEndpoint('http://127.0.0.1:11437', {
      fetchImpl: serving({
        '/v1/models': { body: LLAMACPP_MODELS },
        '/props': { body: { ...LLAMACPP_PROPS, is_sleeping: true } }
      })
    });
    expect(result.ok && result.sleeping).toBe(true);
  });

  /*
   * Each of these sends the user somewhere different, which is why they are not
   * one failure. "Still loading" in particular resolves itself, and calling it
   * unreachable would send somebody looking for a fault that is about to fix
   * itself - a 30GB model takes long enough that Test gets pressed during it.
   */
  it('names the reason it did not get an answer', async () => {
    const cases: Array<[Parameters<typeof serving>[0] | typeof fetch, string]> = [
      [{ '/v1/models': { status: 503 } }, 'loading'],
      [{ '/v1/models': { status: 401 } }, 'auth-required'],
      [{ '/v1/models': { status: 403 } }, 'auth-required'],
      [{ '/v1/models': { status: 500 } }, 'not-openai'],
      [{ '/v1/models': { body: { object: 'list', data: [] } } }, 'no-models'],
      [{ '/v1/models': { body: { hello: 'world' } } }, 'not-openai']
    ];
    for (const [routes, reason] of cases) {
      const result = await probeEndpoint('http://127.0.0.1:9999', {
        fetchImpl: serving(routes as Parameters<typeof serving>[0])
      });
      expect(result).toMatchObject({ ok: false, reason });
    }
  });

  it('tells a closed port from a host that never replied', async () => {
    expect(
      await probeEndpoint('http://127.0.0.1:9999', { fetchImpl: throwing('TypeError') })
    ).toMatchObject({ ok: false, reason: 'refused' });
    expect(
      await probeEndpoint('http://10.0.0.9:9999', { fetchImpl: throwing('TimeoutError') })
    ).toMatchObject({ ok: false, reason: 'timeout' });
  });

  /*
   * A server that answered its models list and then went down between the two
   * calls has still told us what we came for. Losing the whole probe over the
   * optional half of it would report a working endpoint as broken.
   */
  it('survives /props failing after the models list succeeded', async () => {
    let call = 0;
    const fetchImpl = (async (url: string) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(LLAMACPP_MODELS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return Promise.reject(new Error(`gone: ${url}`));
    }) as unknown as typeof fetch;

    const result = await probeEndpoint('http://127.0.0.1:11437', { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toBe('generic');
    // Without /props the allocated figure is gone, and `meta.n_ctx` is what is
    // left - still the served window, not the trained one.
    expect(result.models[0].contextLimit).toBe(16384);
  });
});
