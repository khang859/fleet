import { VOICE_TAP_MAX_MS } from '../../../../shared/agent-voice';

/**
 * The decisions behind the voice button, kept pure so they can be tested
 * without a browser - the same reasoning that put `composerIntent` in
 * `composer-keys.ts`.
 *
 * Everything here is a transition in the seven-state machine from the
 * implementation plan, and the one threshold where tap and hold are told
 * apart. The hook wires these to the real media stack; this file decides what
 * *state* a press, a release, a grant or a failure puts the button in, and
 * what the side effect (ask for the mic, start the recorder, stop it) has to
 * be. The state machine never touches the DOM or getUserMedia - it only says
 * what should happen next.
 */

/** The states from section 7 of the plan. */
export type VoicePhase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing'
  | 'error'
  | 'denied'
  | 'unavailable';

/** What started the active recording, deciding how it ends. */
export type VoiceGesture = 'tap' | 'hold' | null;

/** The button's state, as the renderer needs it. */
export type VoiceState = {
  phase: VoicePhase;
  /** Which gesture started the current recording, for tap vs hold endings. */
  gesture: VoiceGesture;
  /** The last failure, shown in the Notice under the composer. */
  error: string | null;
  /** When the current press went down, so `press-up` can classify it. */
  pressedAt: number | null;
};

/**
 * What the state machine asks the outside world to do. The hook turns each
 * into a real media call; the reducer never performs one itself.
 */
export type VoiceCommand =
  | { kind: 'none' }
  /** Ask for the microphone (getUserMedia, which may surface the OS prompt). */
  | { kind: 'request' }
  /** Create and start the recorder on a granted stream. */
  | { kind: 'capture' }
  /** Stop the recorder and transcribe what was said. */
  | { kind: 'stop' }
  /** Stop the recorder and throw the clip away. */
  | { kind: 'abort' };

/** A press resolved by its duration is either a tap or a hold. */
export function classifyGesture(durationMs: number): VoiceGesture {
  return durationMs < VOICE_TAP_MAX_MS ? 'tap' : 'hold';
}

export type VoiceAction =
  /** Pointer went down (or the keyboard toggle's press half). `at` is now. */
  | { kind: 'press-down'; at: number }
  /** Pointer came up. `at` is now. */
  | { kind: 'press-up'; at: number }
  /**
   * One whole tap, in a single action: the keyboard's way in.
   *
   * `Cmd+Shift+V` and Space/Enter on the button have no down and up separated
   * in time, and sending both halves together loses the press-down's `request`
   * command - the release overwrites it before the render that would have
   * performed it ever commits, leaving the button stuck in `requesting` with no
   * way back. A tap that is one action cannot be dropped that way.
   */
  | { kind: 'toggle' }
  /** Pointer left the button without letting go - a hold being abandoned. */
  | { kind: 'leave' }
  /** getUserMedia succeeded. */
  | { kind: 'grant' }
  /** getUserMedia was refused at the OS. */
  | { kind: 'deny' }
  /** No input device exists. */
  | { kind: 'no-device' }
  /** The recorder stopped on its own (device unplugged, or the cap hit). */
  | { kind: 'ended' }
  /** A transcription finished, or a recording was discarded. */
  | { kind: 'done' }
  /** A request or capture failed - `error` is what the Notice shows. */
  | { kind: 'fail'; error: string }
  /** Leave the error or denied state without retrying. */
  | { kind: 'dismiss' }
  /**
   * Escape's way out: cancel a recording or transcription outright, whatever
   * gesture started it. Unlike `leave` - which only a hold can use - this works
   * from a tap-toggle recording too, because Escape must never be dead.
   */
  | { kind: 'cancel' };

export const IDLE_VOICE_STATE: VoiceState = {
  phase: 'idle',
  gesture: null,
  error: null,
  pressedAt: null
};

/**
 * One transition.
 *
 * The illegal transitions - the ones a well-behaved input never sends - fall
 * through to `{ kind: 'none' }` and change nothing, so the machine is
 * forgiving rather than throwy: a stale grant that arrives after the button
 * has already gone idle is simply ignored.
 */
export function voiceTransition(
  state: VoiceState,
  action: VoiceAction
): { state: VoiceState; command: VoiceCommand } {
  switch (action.kind) {
    case 'press-down': {
      // Idle, error and denied all restart by asking for the mic again. A
      // denied microphone checks its status before re-asking, so this does not
      // loop: the hook sees "still denied" and comes straight back here.
      if (state.phase === 'idle' || state.phase === 'error' || state.phase === 'denied') {
        return {
          state: {
            phase: 'requesting',
            gesture: null,
            error: state.error ?? null,
            pressedAt: action.at
          },
          command: { kind: 'request' }
        };
      }
      // While recording, the press is the gesture's own down-half; the up-half
      // that ends it is handled on release.
      if (state.phase === 'recording') return { state, command: { kind: 'none' } };
      // Transcribing: ignore a fresh press rather than queue a second capture.
      return { state, command: { kind: 'none' } };
    }

    case 'press-up': {
      // A release that arrives while the mic is still being requested is the
      // quick up of a tap: the press is classified and the machine waits for
      // the grant, which will start recording and leave it on.
      if (state.phase === 'requesting') {
        const duration = state.pressedAt === null ? 0 : action.at - state.pressedAt;
        return {
          state: { ...state, gesture: classifyGesture(duration) },
          command: { kind: 'none' }
        };
      }
      // A release while recording ends it, for a hold's release or a tap's
      // toggle-off alike.
      if (state.phase === 'recording') {
        return {
          state: { phase: 'transcribing', gesture: null, error: null, pressedAt: null },
          command: { kind: 'stop' }
        };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'toggle': {
      // The same two ends as a pointer tap - ask for the mic, or stop what is
      // running - reached in one transition so neither command can be lost.
      if (state.phase === 'idle' || state.phase === 'error' || state.phase === 'denied') {
        return {
          state: { phase: 'requesting', gesture: 'tap', error: state.error, pressedAt: null },
          command: { kind: 'request' }
        };
      }
      if (state.phase === 'recording') {
        return {
          state: { phase: 'transcribing', gesture: null, error: null, pressedAt: null },
          command: { kind: 'stop' }
        };
      }
      // Requesting or transcribing: the mic is already spoken for, and a second
      // toggle must not queue a capture behind the one in flight.
      return { state, command: { kind: 'none' } };
    }

    case 'leave': {
      // "Move away to discard": only a hold in progress can leave. A
      // tap-started recording has no finger on the button to leave.
      // A tap-started recording has no finger on the button to leave, so only
      // a hold (gesture `hold`, or an ongoing hold not yet released) can be
      // abandoned by moving the pointer away.
      if (state.phase === 'recording' && state.gesture !== 'tap') {
        return {
          state: IDLE_VOICE_STATE,
          command: { kind: 'abort' }
        };
      }
      // Leaving while the mic is being requested cancels the interest; the
      // grant, when it finally arrives, finds the machine idle and is ignored.
      if (state.phase === 'requesting') {
        return { state: IDLE_VOICE_STATE, command: { kind: 'none' } };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'grant': {
      if (state.phase === 'requesting') {
        return {
          state: { phase: 'recording', gesture: state.gesture, error: null, pressedAt: null },
          command: { kind: 'capture' }
        };
      }
      // A stale grant (the machine moved on while the user was waiting) is
      // ignored rather than starting a capture nobody asked for.
      return { state, command: { kind: 'none' } };
    }

    case 'deny': {
      if (state.phase === 'requesting') {
        return {
          state: { phase: 'denied', gesture: null, error: null, pressedAt: null },
          command: { kind: 'none' }
        };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'no-device': {
      if (state.phase === 'requesting') {
        return {
          state: { phase: 'unavailable', gesture: null, error: null, pressedAt: null },
          command: { kind: 'none' }
        };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'ended': {
      // The recorder stopped on its own - device unplugged, the duration cap,
      // a Bluetooth sample-rate change. Whatever audio exists is transcribed
      // rather than discarded.
      if (state.phase === 'recording') {
        return {
          state: { phase: 'transcribing', gesture: null, error: null, pressedAt: null },
          command: { kind: 'stop' }
        };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'done': {
      if (state.phase === 'transcribing')
        return { state: IDLE_VOICE_STATE, command: { kind: 'none' } };
      return { state, command: { kind: 'none' } };
    }

    case 'fail': {
      if (
        state.phase === 'requesting' ||
        state.phase === 'recording' ||
        state.phase === 'transcribing'
      ) {
        return {
          state: { phase: 'error', gesture: null, error: action.error, pressedAt: null },
          command: { kind: 'none' }
        };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'dismiss': {
      if (state.phase === 'error' || state.phase === 'denied') {
        return { state: IDLE_VOICE_STATE, command: { kind: 'none' } };
      }
      return { state, command: { kind: 'none' } };
    }

    case 'cancel': {
      // Recording or transcribing: Escape aborts, discarding whatever has not
      // already gone out. A pending transcription's result is dropped by the
      // caller rather than here - once the clip has left we can only decline to
      // use the answer.
      if (state.phase === 'recording' || state.phase === 'transcribing') {
        return { state: IDLE_VOICE_STATE, command: { kind: 'abort' } };
      }
      return { state, command: { kind: 'none' } };
    }
  }
}
