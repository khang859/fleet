import { describe, expect, it } from 'vitest';
import type {
  EndpointProbeFailure,
  EndpointProbeResult,
  LocalEndpointState,
  LocalEndpointStatus
} from '../../../../../../../shared/agent-endpoints';
import {
  failureHint,
  failureTitle,
  modelCount,
  newEndpointId,
  statusText,
  statusTone,
  testOutcome
} from '../endpoint-copy';

/**
 * The sentences a person actually reads about a server on their own machine.
 *
 * Worth testing on its own because every judgement in this feature is here and
 * none of the markup is: whether a server that is off counts as broken, whether
 * a server still loading its weights counts as failed, and whether the sentence
 * about either one sends the reader somewhere useful.
 */

const STATUS = (over: Partial<LocalEndpointStatus>): LocalEndpointStatus => ({
  id: 'ep_1',
  state: 'ready',
  fingerprint: 'llamacpp',
  modelCount: 1,
  reason: null,
  detail: null,
  ...over
});

const FAILURES: EndpointProbeFailure[] = [
  'refused',
  'timeout',
  'not-openai',
  'no-models',
  'auth-required',
  'loading'
];

describe('tone', () => {
  it('does not colour a working server as a fault, idle or not', () => {
    expect(statusTone('ready')).toBe('ok');
    expect(statusTone('sleeping')).toBe('ok');
  });

  it('reserves the warning tone for something actually wrong', () => {
    expect(statusTone('unreachable')).toBe('warn');
  });

  it('leaves a server nobody has asked about uncoloured', () => {
    // An endpoint that has not been checked has not failed at anything, and a
    // red dot on it would be the app inventing a fault to report.
    expect(statusTone('unchecked')).toBe('muted');
    expect(statusTone('disabled')).toBe('muted');
  });

  it('has a tone for every state', () => {
    const states: LocalEndpointState[] = [
      'unchecked',
      'checking',
      'ready',
      'sleeping',
      'unreachable',
      'disabled'
    ];
    for (const state of states) expect(statusTone(state)).toBeTruthy();
  });
});

describe('the line on a collapsed row', () => {
  it('says nothing has been checked when no status has arrived', () => {
    expect(statusText(undefined)).toBe('Not checked');
  });

  it('counts models rather than announcing success', () => {
    expect(statusText(STATUS({ state: 'ready', modelCount: 1 }))).toBe('1 model');
    expect(statusText(STATUS({ state: 'ready', modelCount: 3 }))).toBe('3 models');
  });

  it('distinguishes off from not yet asked', () => {
    // Both are grey, and they are not the same thing - which is the whole
    // reason this is text and not a dot.
    expect(statusText(STATUS({ state: 'disabled' }))).toBe('Off');
    expect(statusText(STATUS({ state: 'unchecked', modelCount: 0 }))).toBe('Not checked');
  });

  it('shows what a cold start remembers, and says it is remembered', () => {
    expect(statusText(STATUS({ state: 'unchecked', modelCount: 2 }))).toBe('2 models, saved');
  });

  it('names an idle server as idle rather than as a problem', () => {
    expect(statusText(STATUS({ state: 'sleeping', modelCount: 1 }))).toBe('1 model, idle');
  });

  it('reports the specific failure, not a generic one', () => {
    expect(statusText(STATUS({ state: 'unreachable', reason: 'refused' }))).toBe('Not running');
    expect(statusText(STATUS({ state: 'unreachable', reason: 'loading' }))).toBe('Starting up');
  });
});

describe('model counts', () => {
  it('reads as a sentence at zero and at one', () => {
    expect(modelCount(0)).toBe('No models');
    expect(modelCount(1)).toBe('1 model');
    expect(modelCount(2)).toBe('2 models');
  });
});

describe('failures', () => {
  it('gives every cause its own heading and its own advice', () => {
    const titles = new Set(FAILURES.map((r) => failureTitle(r)));
    const hints = new Set(FAILURES.map((r) => failureHint(r, '127.0.0.1:11437')));
    expect(titles.size).toBe(FAILURES.length);
    expect(hints.size).toBe(FAILURES.length);
  });

  it('names the address in the hints that are about the address', () => {
    expect(failureHint('refused', '127.0.0.1:11437')).toContain('127.0.0.1:11437');
    expect(failureHint('not-openai', '127.0.0.1:11437')).toContain('127.0.0.1:11437');
    expect(failureHint(null, '127.0.0.1:11437')).toContain('127.0.0.1:11437');
  });

  it('does not send someone loading a model off to check their network', () => {
    // The one case where waiting is the right thing to do, and the copy has to
    // say so rather than describe a fault.
    expect(failureHint('loading', '127.0.0.1:11437')).toContain('check again');
    expect(failureTitle('loading')).toBe('Starting up');
  });

  it('falls back to a heading when the cause is unknown', () => {
    expect(failureTitle(null)).toBe('Unreachable');
  });
});

describe('what Test reports', () => {
  const ENTRY = {
    wireId: 'qwen3-30b',
    name: 'qwen3-30b',
    contextLimit: 16384,
    supportsTools: true,
    inputImage: false,
    detail: null
  };

  it('names the flavour of server it found', () => {
    const result: EndpointProbeResult = {
      ok: true,
      fingerprint: 'llamacpp',
      models: [ENTRY],
      sleeping: false
    };
    const outcome = testOutcome(result, '127.0.0.1:11437');
    expect(outcome.tone).toBe('ok');
    expect(outcome.title).toBe('Found a llama.cpp');
    expect(outcome.hint).toBe('Serving qwen3-30b.');
    expect(outcome.models).toEqual(['qwen3-30b']);
  });

  it('does not claim llama.cpp of a server that never said so', () => {
    const result: EndpointProbeResult = {
      ok: true,
      fingerprint: 'generic',
      models: [ENTRY],
      sleeping: false
    };
    expect(testOutcome(result, '127.0.0.1:8080').title).toBe('Found a OpenAI-compatible server');
  });

  it('treats an idle server as found, not as failed', () => {
    const result: EndpointProbeResult = {
      ok: true,
      fingerprint: 'llamacpp',
      models: [ENTRY],
      sleeping: true
    };
    const outcome = testOutcome(result, '127.0.0.1:11437');
    expect(outcome.tone).toBe('ok');
    expect(outcome.title).toContain('idle');
  });

  it('reports a running server with nothing loaded as running', () => {
    const result: EndpointProbeResult = {
      ok: true,
      fingerprint: 'generic',
      models: [],
      sleeping: false
    };
    const outcome = testOutcome(result, '127.0.0.1:8080');
    expect(outcome.tone).toBe('ok');
    expect(outcome.hint).toContain('no model loaded');
    expect(outcome.models).toEqual([]);
  });

  it('warns rather than errors when nothing answered', () => {
    // Baymard's warning-versus-validation line: a process on the user's own
    // laptop being off right now is the ordinary case, and it must not stop
    // them saving the address.
    const result: EndpointProbeResult = { ok: false, reason: 'refused', detail: null };
    const outcome = testOutcome(result, '127.0.0.1:11437');
    expect(outcome.tone).toBe('warn');
    expect(outcome.title).toBe('Not running');
    expect(outcome.models).toEqual([]);
  });
});

describe('endpoint ids', () => {
  it('mints a distinct id each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEndpointId()));
    expect(ids.size).toBe(50);
  });

  it('is not derived from anything the user can edit', () => {
    expect(newEndpointId()).toMatch(/^ep_[0-9a-f]{8}$/);
  });
});
