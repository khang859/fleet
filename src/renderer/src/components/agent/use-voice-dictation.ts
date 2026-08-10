import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  VOICE_MAX_BYTES,
  VOICE_MAX_MS,
  VOICE_SILENCE_RMS,
  VOICE_SILENCE_WINDOW_MS
} from '../../../../shared/agent-voice';
import {
  IDLE_VOICE_STATE,
  voiceTransition,
  type VoiceAction,
  type VoiceCommand,
  type VoiceState
} from './voice-intent';
import { createLogger } from '../../logger';

/**
 * The media half of the voice button: getUserMedia, MediaRecorder, the level
 * meter and every teardown. The interaction decisions live in `voice-intent`;
 * this hook turns its commands into real media calls and reports level and
 * elapsed time back for the meter.
 *
 * Deliberately nothing about where the text goes: the caller's `onTranscript`
 * owns insertion, and the hook never writes to the composer itself - a
 * transcript arriving after the message was already sent is dropped there, not
 * smuggled in here.
 */

/** How long a failed request pauses voice input, so a dead mic does not loop. */
const FAILURE_BACKOFF_MS = 1500;

/** Trace the mic's journey in dev; warn/error reach ~/.fleet/logs/ in prod. */
const log = createLogger('agent:voice');

/** Recorded formats, best first. The type is kept to build a valid Blob. */
function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Failed to read the recording.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Failed to read the recording.'));
    reader.readAsDataURL(blob);
  });
}

type Store = { state: VoiceState; command: VoiceCommand };

function reducer(store: Store, action: VoiceAction): Store {
  const next = voiceTransition(store.state, action);
  return { state: next.state, command: next.command };
}

export type VoiceDictation = {
  /** The machine state, straight from `voice-intent`. */
  state: VoiceState;
  /** 0..1, for the recording level meter. */
  level: number;
  /** Milliseconds into the current recording. */
  elapsed: number;
  /** Recording or transcribing: the moments Escape gives over to voice. */
  active: boolean;
  pressDown: () => void;
  pressUp: () => void;
  /** A whole tap at once, for the keyboard routes that have no hold. */
  toggle: () => void;
  /** The pointer left the button while holding: discard, per the plan. */
  leave: () => void;
  dismiss: () => void;
  /** Escape: cancel a recording or transcription outright. */
  cancel: () => void;
};

/**
 * Read a mutable flag ref through a call.
 *
 * A bare `ref.current` guard narrows the field to `false` for the rest of the closure,
 * and that narrowing outlives the very awaits it exists to guard - the unmount that
 * flips the flag happens while the async call is in flight, so a later `ref.current`
 * read is genuinely `true` at runtime while the type system still says `false`.
 */
function flag(ref: { current: boolean }): boolean {
  return ref.current;
}

export function useVoiceDictation(opts: {
  cwd: string;
  branch: string | null;
  onTranscript: (text: string) => void;
}): VoiceDictation {
  const { cwd, branch, onTranscript } = opts;
  const [store, dispatch] = useReducer(reducer, undefined, () => ({
    state: IDLE_VOICE_STATE,
    command: { kind: 'none' } satisfies VoiceCommand
  }));
  const { state } = store;
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  // Refs for everything the async callbacks touch after the render that made
  // them is gone. The reducer state is read through `phaseRef` so an event -
  // a recorder `stop`, a finished upload - sees the current phase, not the one
  // captured where the callback was defined.
  const phaseRef = useRef<VoiceState['phase']>('idle');
  const disposedRef = useRef(false);
  const requestingRef = useRef(false);
  const settlingRef = useRef(false);
  const retryAtRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef(pickMime());
  const discardRef = useRef(false);
  const rmsTailRef = useRef<number[]>([]);
  const meterRafRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef(0);

  useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);

  const stopTracksAndCloseContext = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current !== null && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close();
    }
    audioCtxRef.current = null;
  }, []);

  // Mount/unmount. Resetting `disposed` here is what makes StrictMode's
  // mount-unmount-remount safe: the first cleanup marks it, the remount's
  // effect clears it again.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Already stopped on its way out.
        }
      }
      stopTracksAndCloseContext();
      if (meterRafRef.current !== null) cancelAnimationFrame(meterRafRef.current);
      if (elapsedTimerRef.current !== null) clearTimeout(elapsedTimerRef.current);
    };
  }, [stopTracksAndCloseContext]);

  const requestMic = useCallback(async (): Promise<void> => {
    try {
      // Main resolves the OS permission first, asking for it once if it never
      // has been: a machine that has never been asked hands getUserMedia a
      // stream of silence rather than refusing, and a returned `denied` never
      // shows the prompt again, so both want saying before the stream is
      // opened rather than after a recording that captured nothing.
      const status = await window.fleet.agent.requestMicrophoneAccess();
      if (flag(disposedRef)) return;
      log.info('microphone access', { status });
      if (status === 'denied' || status === 'restricted') {
        dispatch({ kind: 'deny' });
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (flag(disposedRef)) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        log.info('mic granted');
        streamRef.current = stream;
        dispatch({ kind: 'grant' });
      } catch (err) {
        if (flag(disposedRef)) return;
        // Pause requests briefly: a failing mic retried in a hot loop is noise.
        retryAtRef.current = Date.now() + FAILURE_BACKOFF_MS;
        const name = err instanceof DOMException ? err.name : '';
        log.warn('getUserMedia failed', { name, error: String(err) });
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          dispatch({ kind: 'deny' });
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          dispatch({ kind: 'no-device' });
        } else if (name === 'NotReadableError' || name === 'TrackStartError') {
          dispatch({ kind: 'fail', error: 'Another app is using the microphone.' });
        } else {
          dispatch({ kind: 'fail', error: 'Could not start the microphone.' });
        }
      }
    } catch (err) {
      // The status IPC rejected - never let that strand the button in
      // `requesting` (disabled, silent). Fall to an error it can recover from.
      if (flag(disposedRef)) return;
      log.error('microphone status call failed', { error: String(err) });
      retryAtRef.current = Date.now() + FAILURE_BACKOFF_MS;
      dispatch({ kind: 'fail', error: 'Could not check the microphone.' });
    }
  }, []);

  const startMetering = useCallback(() => {
    const analyser = analyserRef.current;
    if (analyser === null) return;
    const bucket = new Uint8Array(analyser.fftSize);
    const tailLength = Math.ceil(VOICE_SILENCE_WINDOW_MS / 16);
    const loop = (): void => {
      if (flag(disposedRef)) return;
      const live = analyserRef.current;
      if (live !== null) {
        live.getByteTimeDomainData(bucket);
        let sum = 0;
        for (const v of bucket) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / bucket.length);
        rmsTailRef.current.push(rms);
        if (rmsTailRef.current.length > tailLength) rmsTailRef.current.shift();
        setLevel(Math.min(1, rms * 6));
      }
      meterRafRef.current = requestAnimationFrame(loop);
    };
    meterRafRef.current = requestAnimationFrame(loop);
  }, []);

  const stopMetering = useCallback(() => {
    if (meterRafRef.current !== null) cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
  }, []);

  const stopElapsed = useCallback(() => {
    if (elapsedTimerRef.current !== null) clearTimeout(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }, []);

  // startCapture, settle, finishRecording and startup of the elapsed tick.
  // Declared before the command effect so the effect can reference them.
  const settleRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const startCapture = useCallback((): void => {
    const stream = streamRef.current;
    if (stream === null) return;
    mimeTypeRef.current = pickMime();
    const mime = mimeTypeRef.current;
    let recorder: MediaRecorder;
    try {
      recorder =
        mime === '' ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType: mime });
    } catch {
      recorder = new MediaRecorder(stream);
      mimeTypeRef.current = '';
    }
    const chunks: Blob[] = [];
    chunksRef.current = chunks;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      void settleRef.current?.();
    };
    recorderRef.current = recorder;
    discardRef.current = false;

    // Level metering, best-effort: a silent browser that cannot build an
    // AudioContext still records fine, it just shows no meter.
    try {
      // Chromium (Electron) always has AudioContext, so no fallback to guard.
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      sourceRef.current = source;
      analyserRef.current = analyser;
      audioCtxRef.current = ctx;
      startMetering();
    } catch {
      // Metering off; recording continues.
    }

    recorder.start();
    startTimeRef.current = Date.now();
    setElapsed(0);

    elapsedTimerRef.current = setTimeout(function tick() {
      const now = Date.now() - startTimeRef.current;
      setElapsed(now);
      if (now >= VOICE_MAX_MS) {
        // The cap hits: stop and transcribe what is there, with a countdown
        // already shown as it approached.
        dispatch({ kind: 'ended' });
        return;
      }
      elapsedTimerRef.current = setTimeout(tick, 100);
    }, 100);
  }, [startMetering]);

  const isSilent = useCallback((): boolean => {
    const tail = rmsTailRef.current;
    const windowSamples = Math.ceil(VOICE_SILENCE_WINDOW_MS / 16);
    const cut = tail.slice(-windowSamples);
    if (cut.length === 0) return false;
    return cut.reduce((sum, rms) => sum + rms, 0) / cut.length < VOICE_SILENCE_RMS;
  }, []);

  const settle = useCallback(async (): Promise<void> => {
    if (settlingRef.current) return;
    settlingRef.current = true;
    stopMetering();
    stopElapsed();
    // An unplugged device stops the recorder without ever going through a
    // release, so the UI is moved into transcribing before the upload begins.
    if (phaseRef.current === 'recording') dispatch({ kind: 'ended' });

    const discard = discardRef.current;
    discardRef.current = false;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    stopTracksAndCloseContext();
    recorderRef.current = null;

    try {
      if (discard) {
        dispatch({ kind: 'done' });
        return;
      }
      const blob = chunks.length === 0 ? null : new Blob(chunks, { type: mimeTypeRef.current });
      // The silence gate is the mitigation for Whisper hallucinating text out
      // of nothing: a near-silent clip is dropped before it ever reaches a
      // model that would invent words for it.
      if (blob === null || blob.size > VOICE_MAX_BYTES || isSilent()) {
        if (blob !== null && blob.size > VOICE_MAX_BYTES) {
          dispatch({ kind: 'fail', error: 'That recording is too large to transcribe.' });
        } else {
          dispatch({ kind: 'done' });
        }
        return;
      }
      const base64 = await blobToBase64(blob);
      const result = await window.fleet.agent.transcribe({
        cwd,
        branch,
        audioBase64: base64,
        mimeType: mimeTypeRef.current
      });
      if (flag(disposedRef)) return; // unmounted: drop the transcript
      if (result.ok) {
        if (result.text !== '') onTranscript(result.text);
        dispatch({ kind: 'done' });
      } else {
        // A failed request must not destroy what was said - the renderer holds
        // the error and the state is 'error', where a retry re-asks.
        dispatch({ kind: 'fail', error: result.error });
      }
    } finally {
      settlingRef.current = false;
    }
  }, [cwd, branch, onTranscript, isSilent, stopMetering, stopElapsed, stopTracksAndCloseContext]);

  settleRef.current = settle;

  const finishRecording = useCallback(
    (transcribe: boolean): void => {
      discardRef.current = !transcribe;
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          void settle();
        }
      } else {
        void settle();
      }
    },
    [settle]
  );

  // Run the command the reducer produced. Every transition to a side effect
  // funnels through here, so the reducer stays pure.
  useEffect(() => {
    switch (store.command.kind) {
      case 'request': {
        if (requestingRef.current) break;
        const wait = retryAtRef.current - Date.now();
        if (wait > 0) {
          dispatch({
            kind: 'fail',
            error: 'The microphone is recovering - try again in a moment.'
          });
          break;
        }
        requestingRef.current = true;
        void requestMic().finally(() => {
          requestingRef.current = false;
        });
        break;
      }
      case 'capture':
        startCapture();
        break;
      case 'stop':
        finishRecording(true);
        break;
      case 'abort':
        finishRecording(false);
        break;
      case 'none':
        break;
    }
  }, [store.command, requestMic, startCapture, finishRecording]);

  const active = state.phase === 'recording' || state.phase === 'transcribing';

  const pressDown = useCallback(() => dispatch({ kind: 'press-down', at: Date.now() }), []);
  const pressUp = useCallback(() => dispatch({ kind: 'press-up', at: Date.now() }), []);
  const toggle = useCallback(() => dispatch({ kind: 'toggle' }), []);
  const leave = useCallback(() => dispatch({ kind: 'leave' }), []);
  const dismiss = useCallback(() => dispatch({ kind: 'dismiss' }), []);
  const cancel = useCallback(() => dispatch({ kind: 'cancel' }), []);

  return { state, level, elapsed, active, pressDown, pressUp, toggle, leave, dismiss, cancel };
}
