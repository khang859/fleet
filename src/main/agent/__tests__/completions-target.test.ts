import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOnce, streamCompletion, type CompletionsTarget } from '../completions';
import { openRouterTarget } from '../openrouter';

/**
 * What changes on the wire when the call is going to this machine instead.
 *
 * The client itself has no provider branch - the whole of the difference is the
 * `CompletionsTarget` a caller hands over - so this file is where that claim is
 * checked. Every case below was found against a real `llama-server`, and three
 * of them were silent failures rather than errors: a missing usage block reads
 * as a turn that cost nothing, an ignored reasoning parameter reads as a model
 * with nothing to say, and reasoning under a different field name reads as no
 * thinking at all.
 */

const LOCAL: CompletionsTarget = {
  baseUrl: 'http://127.0.0.1:11437/v1',
  apiKey: null,
  extraHeaders: {},
  requestUsage: true,
  reasoningDialect: 'chat-template-kwargs',
  serverTools: false,
  label: '127.0.0.1:11437'
};

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** Captures one request and answers with a well-formed completion. */
function capture(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Sent['body'] });
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
      );
    })
  );
  return sent;
}

/** The same, answering with an SSE stream of the given chunks. */
function streaming(chunks: unknown[]): Sent[] {
  const sent: Sent[] = [];
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}`), 'data: [DONE]'];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Sent['body'] });
      return Promise.resolve(new Response(`${lines.join('\n\n')}\n\n`, { status: 200 }));
    })
  );
  return sent;
}

const once = { model: 'qwen3-coder', messages: [], maxTokens: 8, temperature: 0 };

const stream = {
  model: 'qwen3-coder',
  messages: [],
  maxTokens: null,
  temperature: null,
  reasoning: null,
  signal: new AbortController().signal,
  onDelta: () => {},
  onReasoning: () => {}
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('where the call goes', () => {
  it('calls the endpoint under the address it was given', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: LOCAL, reasoning: null });
    expect(sent[0].url).toBe('http://127.0.0.1:11437/v1/chat/completions');
  });

  /*
   * Omitted rather than sent empty. A server started without `--api-key`
   * ignores the header either way, but one started *with* one rejects a
   * malformed bearer instead of reading it as absent - which turns "no key
   * needed" into a 401 the user cannot act on.
   */
  it('sends no Authorization at all when there is no key', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: LOCAL, reasoning: null });
    expect(sent[0].headers).not.toHaveProperty('Authorization');
    expect(sent[0].headers['Content-Type']).toBe('application/json');
  });

  it('still sends the key and the attribution headers to OpenRouter', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: openRouterTarget('sk-or-test'), reasoning: null });
    expect(sent[0].headers).toMatchObject({
      Authorization: 'Bearer sk-or-test',
      'X-Title': 'Fleet'
    });
  });
});

describe('asking for usage', () => {
  /*
   * OpenRouter volunteers usage on the last message of every stream. An
   * OpenAI-compatible server sends none without this, and a stream without it
   * is not an error - it silently accounts for nothing, so the context meter
   * stays empty and the spend meter blank for the whole conversation.
   */
  it('asks a local server for the usage it will not volunteer', async () => {
    const sent = streaming([{ choices: [{ delta: { content: 'hi' } }] }]);
    await streamCompletion({ ...stream, target: LOCAL });
    expect(sent[0].body).toMatchObject({ stream_options: { include_usage: true } });
  });

  it('does not ask OpenRouter for what it sends anyway', async () => {
    const sent = streaming([{ choices: [{ delta: { content: 'hi' } }] }]);
    await streamCompletion({ ...stream, target: openRouterTarget('sk-or-test') });
    expect(sent[0].body).not.toHaveProperty('stream_options');
  });
});

describe('asking a model not to think', () => {
  /*
   * The failure this exists for. `reasoning` is OpenRouter's own parameter and
   * llama.cpp ignores it - not with an error, which is what made it expensive.
   * A title asked for in 24 tokens came back empty, having spent all 24
   * thinking, and `resolveTitle` reads an empty answer as a model with nothing
   * to say: naming a session silently stopped working, and every command in
   * auto mode fell back to asking the user.
   */
  it('turns thinking off through the chat template on a local server', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: LOCAL, reasoning: { enabled: false } });
    expect(sent[0].body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(sent[0].body).not.toHaveProperty('reasoning');
  });

  it('turns it on the same way', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: LOCAL, reasoning: { enabled: true } });
    expect(sent[0].body).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
  });

  it('keeps sending OpenRouter the parameter it understands', async () => {
    const sent = capture();
    await completeOnce({
      ...once,
      target: openRouterTarget('sk-or-test'),
      reasoning: { enabled: false }
    });
    expect(sent[0].body).toMatchObject({ reasoning: { enabled: false } });
    expect(sent[0].body).not.toHaveProperty('chat_template_kwargs');
  });

  /*
   * There is no effort level and no thinking budget on the local side, so
   * saying nothing leaves the model's own default in place. That is the honest
   * answer - Fleet has no way to turn "high" into a setting a llama-server
   * would recognise, and inventing one would be worse than leaving it alone.
   */
  it('says nothing about an effort a local server has no notion of', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: LOCAL, reasoning: { effort: 'high' } });
    expect(sent[0].body).not.toHaveProperty('chat_template_kwargs');
    expect(sent[0].body).not.toHaveProperty('reasoning');
  });

  it('says nothing on either side when the caller said nothing', async () => {
    const sent = capture();
    await completeOnce({ ...once, target: LOCAL, reasoning: null });
    expect(sent[0].body).not.toHaveProperty('chat_template_kwargs');
  });
});

describe('reading what came back', () => {
  /*
   * llama.cpp calls it `reasoning_content`; OpenRouter calls it `reasoning`.
   * Read only under the one name, a local model's thinking would arrive as
   * nothing at all and the pane would sit blank while the model worked.
   */
  it('reads thinking under the name llama.cpp gives it', async () => {
    streaming([
      { choices: [{ delta: { reasoning_content: 'let me see' } }] },
      { choices: [{ delta: { content: 'the answer' } }] }
    ]);
    let reasoning = '';
    let text = '';
    await streamCompletion({
      ...stream,
      target: LOCAL,
      onReasoning: (d) => (reasoning += d),
      onDelta: (d) => (text += d)
    });
    expect(reasoning).toBe('let me see');
    expect(text).toBe('the answer');
  });

  it('still reads it under the name OpenRouter gives it', async () => {
    streaming([{ choices: [{ delta: { reasoning: 'thinking' } }] }]);
    let reasoning = '';
    await streamCompletion({
      ...stream,
      target: openRouterTarget('sk-or-test'),
      onReasoning: (d) => (reasoning += d)
    });
    expect(reasoning).toBe('thinking');
  });
});

describe('what a failure is called', () => {
  /*
   * Every sentence this file produces ends up on screen, and "OpenRouter
   * stopped responding" is actively misleading about a request that never left
   * the machine - it sends somebody to check an account instead of a terminal.
   */
  it('blames the endpoint the call was actually made to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(new Response('nope', { status: 400 })))
    );
    await expect(completeOnce({ ...once, target: LOCAL, reasoning: null })).rejects.toThrow(
      '127.0.0.1:11437'
    );
  });

  it('names an endpoint by what the user called it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(new Response('nope', { status: 400 })))
    );
    await expect(
      completeOnce({ ...once, target: { ...LOCAL, label: 'Workstation' }, reasoning: null })
    ).rejects.toThrow('Workstation');
  });
});
