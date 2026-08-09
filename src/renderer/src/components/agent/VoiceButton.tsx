import { useRef } from 'react';
import { Loader2, Mic, MicOff, TriangleAlert } from 'lucide-react';
import { VOICE_TAP_MAX_MS } from '../../../../shared/agent-voice';
import type { VoicePhase } from './voice-intent';
import type { VoiceDictation } from './use-voice-dictation';

/**
 * The voice dictation control and its seven states (section 7 of the plan).
 *
 * A pointer press shorter than the tap threshold toggles recording on and
 * leaves it on; a longer press is a hold that records until release. The state
 * machine lives in `voice-intent.ts`; this component only renders the result
 * and relays pointer and keyboard input to the hook that drives it.
 *
 * Hidden rather than disabled in `unavailable`: a control that can never do
 * anything is worse than no control.
 */
export function VoiceButton({
  voice,
  unavailable
}: {
  voice: VoiceDictation;
  /** No key or no model: nothing to transcribe with. */
  unavailable: boolean;
}): React.JSX.Element | null {
  const { state } = voice;
  const { phase } = state;
  // When the current press started, so a pointer that wanders off can be told a
  // genuine hold (long enough to mean "move away to discard") from a jittery
  // tap that barely crossed the button.
  const downAtRef = useRef<number | null>(null);

  // Hidden in unavailable, however we got there: a missing device (reducer),
  // or no key / no model (the caller). A hidden control is not a state, so it
  // is not given buttons - the plan forbids a control that can never act.
  if (unavailable || phase === 'unavailable') return null;

  const interactive =
    phase === 'idle' || phase === 'recording' || phase === 'error' || phase === 'denied';

  return (
    <button
      type="button"
      aria-label="Voice dictate"
      title={titleFor(phase)}
      // Pointer events, not clicks: a click cannot tell a tap from a hold, and
      // that distinction is the whole of the interaction. `preventDefault`
      // keeps the press from also focusing and scrolling the composer.
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        downAtRef.current = Date.now();
        voice.pressDown();
      }}
      onPointerUp={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        downAtRef.current = null;
        voice.pressUp();
      }}
      // Moving the pointer off without releasing is "move away to discard" -
      // but only for a genuine hold. A tap that drifted a pixel over the edge
      // mid-click must not abort the recording it just asked for.
      onPointerLeave={() => {
        const downAt = downAtRef.current;
        if (downAt === null || Date.now() - downAt < VOICE_TAP_MAX_MS) return;
        downAtRef.current = null;
        voice.leave();
      }}
      onPointerCancel={() => {
        const downAt = downAtRef.current;
        if (downAt === null || Date.now() - downAt < VOICE_TAP_MAX_MS) return;
        downAtRef.current = null;
        voice.leave();
      }}
      onKeyDown={(e) => {
        // Space/Enter have no honest hold on a keyboard, so they toggle: one
        // whole tap, sent as one action so the press-down's request survives
        // the render it shares with the release.
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        voice.toggle();
      }}
      // `aria-disabled` rather than `disabled`: the browser pulls focus off a
      // control the moment it goes disabled, and `requesting` is a phase the
      // button passes through on its way to recording - so a keyboard user who
      // pressed Space to start would lose the button before they could press
      // Space again to stop. Pointer events are dropped in the class instead,
      // and the state machine already ignores presses in these phases.
      aria-disabled={!interactive}
      aria-pressed={phase === 'recording'}
      className={buttonClass(phase)}
    >
      {phase === 'recording' ? <RecordingGlyph /> : <Glyph phase={phase} />}
    </button>
  );
}

/** A filled accent disc while capturing, with a confirm pulse. */
function RecordingGlyph(): React.JSX.Element {
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      <span className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-fleet-accent opacity-40" />
      <span className="size-3 rounded-full bg-white" />
    </span>
  );
}

function Glyph({ phase }: { phase: VoicePhase }): React.JSX.Element {
  // Transcribing: a quiet, indeterminate indicator - something is happening,
  // and it is not the user's turn to do anything about it.
  if (phase === 'transcribing') return <Loader2 size={14} className="shrink-0 animate-spin" />;
  // Denied: the mic with a slash through it.
  if (phase === 'denied') return <MicOff size={14} className="shrink-0" />;
  // Error: the same mic, amber, carrying the last failure.
  if (phase === 'error') return <TriangleAlert size={14} className="shrink-0" />;
  return <Mic size={14} className="shrink-0" />;
}

function titleFor(phase: VoicePhase): string {
  switch (phase) {
    case 'requesting':
      return 'Waiting for the microphone…';
    case 'recording':
      return 'Recording - click to stop and insert';
    case 'transcribing':
      return 'Transcribing…';
    case 'denied':
      return 'Microphone blocked - grant it in System Settings';
    case 'error':
      return 'Last attempt failed - click to retry';
    case 'idle':
    case 'unavailable':
      return 'Hold to talk, click to toggle';
  }
}

function buttonClass(phase: VoicePhase): string {
  const base =
    'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors focus-ring';
  switch (phase) {
    case 'requesting':
      return `${base} pointer-events-none text-fleet-text-subtle opacity-40`;
    case 'recording':
      return `${base} relative bg-fleet-accent text-white`;
    case 'transcribing':
      return `${base} pointer-events-none cursor-default text-fleet-text-subtle`;
    case 'denied':
      return `${base} text-fleet-text-subtle`;
    case 'error':
      return `${base} text-amber-500 hover:bg-fleet-surface-2`;
    case 'idle':
    case 'unavailable':
      return `${base} text-fleet-text-muted hover:bg-fleet-surface-2 hover:text-fleet-text`;
  }
}
