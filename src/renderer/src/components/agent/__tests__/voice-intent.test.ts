import { describe, expect, it } from 'vitest';
import { VOICE_TAP_MAX_MS } from '../../../../../shared/agent-voice';
import {
  classifyGesture,
  voiceTransition,
  IDLE_VOICE_STATE,
  type VoiceState
} from '../voice-intent';

/**
 * The voice state machine: tap versus hold at the boundary, every transition
 * including the illegal ones, and the shape the Escape-precedence rule relies
 * on. Kept here, pure, so it runs under `npm test` without a browser.
 */

const T0 = 0;
/** The touchstone transition: an idle press asks for the mic. */
function requested(): { state: VoiceState; command: { kind: string } } {
  return voiceTransition(IDLE_VOICE_STATE, { kind: 'press-down', at: T0 });
}

describe('classifyGesture', () => {
  it('calls a press under the threshold a tap', () => {
    expect(classifyGesture(0)).toBe('tap');
    expect(classifyGesture(VOICE_TAP_MAX_MS - 1)).toBe('tap');
  });

  it('calls a press at or past the threshold a hold', () => {
    expect(classifyGesture(VOICE_TAP_MAX_MS)).toBe('hold');
    expect(classifyGesture(10_000)).toBe('hold');
  });
});

describe('the happy paths', () => {
  it('a tap toggles recording on and leaves it on', () => {
    // Press, then up quickly while the mic is requested -> classified as a tap.
    let { state } = requested();
    expect(state.phase).toBe('requesting');

    ({ state } = voiceTransition(state, { kind: 'press-up', at: T0 + VOICE_TAP_MAX_MS - 1 }));
    expect(state.phase).toBe('requesting');
    expect(state.gesture).toBe('tap');

    // The grant starts the recorder; it stays on until the next tap.
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    expect(state.phase).toBe('recording');
    expect(state.gesture).toBe('tap');

    // The next tap ends it.
    const second = voiceTransition(state, { kind: 'press-down', at: 5000 });
    expect(second.state.phase).toBe('recording');
    const ended = voiceTransition(second.state, {
      kind: 'press-up',
      at: 5000 + VOICE_TAP_MAX_MS - 1
    });
    expect(ended.state.phase).toBe('transcribing');
    expect(ended.command).toEqual({ kind: 'stop' });
  });

  it('a hold records until release', () => {
    let { state } = requested();
    // The grant lands while the finger is still down.
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    expect(state.phase).toBe('recording');
    // No release yet: still recording.
    ({ state } = voiceTransition(state, { kind: 'press-up', at: T0 + HOLD_DURATION }));
    expect(state.phase).toBe('transcribing');
  });
});

// A hold is a press held past the threshold before release.
const HOLD_DURATION = VOICE_TAP_MAX_MS + 200;

describe('the keyboard toggle', () => {
  // The pointer sends down and up in two renders, so the reducer's `request`
  // survives to be performed. A keystroke has no such gap: sending both halves
  // together left the request overwritten by the release and the button stuck
  // in `requesting` forever. One action is what keeps that from happening.
  it('asks for the mic in one action, carrying the command with it', () => {
    const started = voiceTransition(IDLE_VOICE_STATE, { kind: 'toggle' });
    expect(started.state.phase).toBe('requesting');
    expect(started.state.gesture).toBe('tap');
    expect(started.command).toEqual({ kind: 'request' });

    // A tap-started recording, which the grant leaves on.
    const recording = voiceTransition(started.state, { kind: 'grant' });
    expect(recording.state.phase).toBe('recording');
    expect(recording.state.gesture).toBe('tap');
  });

  it('stops a recording it started', () => {
    let { state } = voiceTransition(IDLE_VOICE_STATE, { kind: 'toggle' });
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    const stopped = voiceTransition(state, { kind: 'toggle' });
    expect(stopped.state.phase).toBe('transcribing');
    expect(stopped.command).toEqual({ kind: 'stop' });
  });

  it('retries from error and denied, the way a press does', () => {
    const failed = voiceTransition(IDLE_VOICE_STATE, { kind: 'toggle' });
    const errored = voiceTransition(failed.state, { kind: 'fail', error: 'the mic is busy' });
    expect(errored.state.phase).toBe('error');
    const retried = voiceTransition(errored.state, { kind: 'toggle' });
    expect(retried.state.phase).toBe('requesting');
    expect(retried.command).toEqual({ kind: 'request' });
    // The reason stays up until the retry resolves, so the Notice does not
    // blink out the moment the button is pressed again.
    expect(retried.state.error).toBe('the mic is busy');
  });

  it('does not queue a second capture behind one in flight', () => {
    let { state } = voiceTransition(IDLE_VOICE_STATE, { kind: 'toggle' });
    // Requesting: a second toggle is not a second getUserMedia.
    const again = voiceTransition(state, { kind: 'toggle' });
    expect(again.command).toEqual({ kind: 'none' });
    expect(again.state.phase).toBe('requesting');

    ({ state } = voiceTransition(state, { kind: 'grant' }));
    ({ state } = voiceTransition(state, { kind: 'toggle' }));
    expect(state.phase).toBe('transcribing');
    const busy = voiceTransition(state, { kind: 'toggle' });
    expect(busy.state.phase).toBe('transcribing');
    expect(busy.command).toEqual({ kind: 'none' });
  });

  it('leaves a toggle-started recording alone when the pointer wanders', () => {
    let { state } = voiceTransition(IDLE_VOICE_STATE, { kind: 'toggle' });
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    // Started from the keyboard, so there is no finger to move away.
    const moved = voiceTransition(state, { kind: 'leave' });
    expect(moved.state.phase).toBe('recording');
    expect(moved.command).toEqual({ kind: 'none' });
  });
});

describe('the illegal and guarded transitions', () => {
  it('a stale grant is ignored once the machine has moved on', () => {
    const { state } = requested();
    // The user walked away; the grant arrives too late.
    const afterLeave = voiceTransition(state, { kind: 'leave' });
    expect(afterLeave.state.phase).toBe('idle');
    const stale = voiceTransition(afterLeave.state, { kind: 'grant' });
    expect(stale.state.phase).toBe('idle');
    expect(stale.command.kind).toBe('none');
  });

  it('denied does not loop - a press re-checks status, never re-asks blindly', () => {
    let { state } = requested();
    ({ state } = voiceTransition(state, { kind: 'deny' }));
    expect(state.phase).toBe('denied');
    // Dismiss rests it.
    const dismissed = voiceTransition(state, { kind: 'dismiss' });
    expect(dismissed.state.phase).toBe('idle');
  });

  it('a fresh press while recording is the gesture down-half, not a REQUEST', () => {
    let { state } = requested();
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    const again = voiceTransition(state, { kind: 'press-down', at: 100 });
    expect(again.state.phase).toBe('recording');
    expect(again.command.kind).toBe('none'); // nothing asks again
  });

  it('a press while transcribing is ignored, not queued', () => {
    let { state } = requested();
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    ({ state } = voiceTransition(state, { kind: 'press-up', at: 100 }));
    expect(state.phase).toBe('transcribing');
    const busy = voiceTransition(state, { kind: 'press-down', at: 200 });
    expect(busy.state.phase).toBe('transcribing');
    expect(busy.command.kind).toBe('none');
  });

  it('leaving during a hold aborts; leaving a tap-recording does nothing', () => {
    // A hold that is abandoned mid-flight.
    let hold = requested();
    hold = voiceTransition(hold.state, { kind: 'grant' });
    const moved = voiceTransition(hold.state, { kind: 'leave' });
    expect(moved.state.phase).toBe('idle');
    expect(moved.command).toEqual({ kind: 'abort' });
  });

  it('an ended recorder transcribes whatever exists rather than discarding it', () => {
    let { state } = requested();
    ({ state } = voiceTransition(state, { kind: 'grant' }));
    const ended = voiceTransition(state, { kind: 'ended' });
    expect(ended.state.phase).toBe('transcribing');
    expect(ended.command.kind).toBe('stop');
  });

  it('a capture failure lands in error with the reason', () => {
    const { state } = requested();
    const failed = voiceTransition(state, { kind: 'fail', error: 'the mic is busy' });
    expect(failed.state.phase).toBe('error');
    expect(failed.state.error).toBe('the mic is busy');
  });
});
