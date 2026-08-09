import { describe, expect, it, vi, afterEach } from 'vitest';
import { transcribe, buildHints } from '../transcribe';
import type { AgentTranscribeRequest } from '../../../shared/agent-voice';

/**
 * The OpenRouter transcription call: raw base64 with no `data:` prefix, the
 * provider block present only for a model that supports hints, distinct
 * messages for 401/402/429/500, and a zod-validated response so `undefined`
 * is never pasted into the composer.
 */

const API_KEY = 'sk-or-test';
const MODEL = 'openai/whisper-large-v3-turbo';
const REQ: AgentTranscribeRequest = {
  cwd: '/Users/khang/Development/fleet',
  branch: 'voice-dictation',
  audioBase64: 'AAAABBBB',
  mimeType: 'audio/webm;codecs=opus'
};

function okFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildHints', () => {
  it('spends the budget on the folder name, the branch and coding terms', () => {
    expect(buildHints('/Users/khang/Development/fleet', 'voice-dictation')).toContain('fleet');
    expect(buildHints('/Users/khang/Development/fleet', 'voice-dictation')).toContain(
      'voice-dictation'
    );
    expect(buildHints('/Users/khang/Development/fleet', 'voice-dictation')).toContain('regex');
  });

  it('is happy with no branch', () => {
    expect(buildHints('/tmp/some-folder', null)).toContain('some-folder');
  });

  it('survives a trailing slash and a deeppath', () => {
    expect(buildHints('/a/b/c/', null)).toContain('c');
  });
});

describe('request shape', () => {
  it('sends raw base64, not a data URL, with the model and a webm format', async () => {
    const spy = okFetch({ text: 'refactor the composer' });
    vi.stubGlobal('fetch', spy);

    const result = await transcribe(API_KEY, MODEL, REQ);

    expect(result).toEqual({ ok: true, text: 'refactor the composer' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    const body = JSON.parse(init.body as string);
    expect(body.input_audio.data).toBe('AAAABBBB'); // no `data:` prefix
    expect(body.input_audio.format).toBe('webm');
    expect(body.model).toBe(MODEL);
  });

  it('pins the provider and adds groq hints for a hints-capable model', async () => {
    const spy = okFetch({ text: 'x' });
    vi.stubGlobal('fetch', spy);
    await transcribe(API_KEY, MODEL, REQ);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.provider).toEqual({
      options: { groq: { prompt: expect.stringContaining('fleet') } }
    });
  });

  it('omits the provider block when the model does not support hints', async () => {
    const spy = okFetch({ text: 'x' });
    vi.stubGlobal('fetch', spy);
    await transcribe(API_KEY, 'fishaudio/fish-transcribe-1', REQ);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.provider).toBeUndefined();
  });

  it('refuses an over-limit clip before fetching', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const huge = { ...REQ, audioBase64: 'A'.repeat(34_000_000) };
    await expect(transcribe(API_KEY, MODEL, huge)).resolves.toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a clip with no usable format', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(transcribe(API_KEY, MODEL, { ...REQ, mimeType: '' })).resolves.toMatchObject({
      ok: false,
      error: 'That audio format cannot be transcribed.'
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'key is not valid'],
    [402, 'no OpenRouter credits'],
    [429, 'rate limiting']
  ])('explains a %i', async (status, needle) => {
    vi.stubGlobal('fetch', okFetch({ error: { message: 'nope' } }, status));
    const result = await transcribe(API_KEY, MODEL, REQ);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain(needle.toLowerCase());
  });

  it('falls back to the server message for other statuses', async () => {
    vi.stubGlobal('fetch', okFetch({ error: { message: 'the upstream died' } }, 500));
    const result = await transcribe(API_KEY, MODEL, REQ);
    if (!result.ok) expect(result.error).toContain('the upstream died');
  });

  it('treats a network drop as kept-audio retry, not data loss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const result = await transcribe(API_KEY, MODEL, REQ);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('kept');
  });
});

describe('zod rejection', () => {
  it('is an error, never undefined pasted into the box', async () => {
    vi.stubGlobal('fetch', okFetch({ something_else: true }));
    const result = await transcribe(API_KEY, MODEL, REQ);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unreadable');
  });
});
