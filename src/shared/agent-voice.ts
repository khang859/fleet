/**
 * Voice dictation for the Agent pane: speaking a prompt into the composer
 * instead of typing it.
 *
 * The renderer captures the clip and owns the interaction state; main
 * transcribes it over OpenRouter and hands the text back; the composer inserts
 * it at the caret. This file is the contract the two sides of the IPC share -
 * the settings type, the request and result shapes, and the constants that keep
 * capture in one place and upload limits in the other from quietly disagreeing
 * about what is allowed.
 */

/**
 * Longest a recording may run before it auto-stops.
 *
 * Most dictation is a sentence or two, and the 25 MB upload ceiling buys far
 * longer than this at any realistic bitrate, so the cap is a courtesy rather
 * than an upload limit: it exists so a recording that nobody stops does not run
 * for a quarter of an hour. The duration also bounds the size of the single
 * structured clone that crosses the IPC when the clip finishes.
 */
export const VOICE_MAX_MS = 60_000;

/**
 * How close to the cap the readout turns into a countdown.
 *
 * Until then it shows elapsed time, because that is what someone speaking wants
 * to know; a recording that counts down from a full minute frames every
 * five-second sentence as a deadline.
 */
export const VOICE_COUNTDOWN_MS = 15_000;

/**
 * A pointer press shorter than this is a tap, which toggles recording on and
 * leaves it on; a longer press is a hold, which records until release. Both
 * drive the same state machine, so neither is a second-class path.
 */
export const VOICE_TAP_MAX_MS = 250;

/**
 * OpenRouter refuses audio over 25 MB; refuse before upload, as data rather
 * than as a throw, following the attachment precedent.
 */
export const VOICE_MAX_BYTES = 25_000_000;

/**
 * Mean RMS below which a clip counts as silent and is dropped before upload.
 *
 * Whisper is known to hallucinate confident text out of silence, so this gate
 * is the mitigation rather than a nicety: a silent clip never reaches a model
 * that would invent words for it.
 */
export const VOICE_SILENCE_RMS = 0.01;

/**
 * How much of the tail is judged for silence, in milliseconds of captured
 * audio. Tuned against a real microphone in section 12; the meter reports RMS
 * over this window and the clip is dropped when the mean stays under
 * `VOICE_SILENCE_RMS`.
 */
export const VOICE_SILENCE_WINDOW_MS = 1000;

/** One selectable transcription model, from the curated list. */
export type AgentVoiceModel = {
  id: string;
  name: string;
  /**
   * Whether the model honours the vocabulary hints (recognition biasing for
   * the project folder, the git branch and coding terms). Hints only work
   * through Groq's provider passthrough, so a model whose provider does not
   * support them degrades in accuracy silently - which is why the settings
   * pane says which these are.
   */
  hints: boolean;
};

/**
 * The transcription models the settings pane offers.
 *
 * Curated rather than the whole OpenRouter audio catalogue, the same way the
 * coding model list is a search over models.dev: it is short enough to be a
 * real choice, and each entry says whether choosing it loses the hints.
 *
 * The default is pinned to the Groq provider so the hints in section 4.1 apply
 * out of the box; see the implementation plan for the pricing and why cost is
 * not a selection criterion at this volume.
 */
export const AGENT_VOICE_MODELS: AgentVoiceModel[] = [
  {
    id: 'openai/whisper-large-v3-turbo',
    name: 'OpenAI Whisper Large v3 Turbo',
    hints: true
  },
  { id: 'openai/whisper-large-v3', name: 'OpenAI Whisper Large v3', hints: false },
  { id: 'grok/stt', name: 'Grok STT 1.0', hints: false },
  { id: 'fishaudio/fish-transcribe-1', name: 'Fish Audio Transcribe 1', hints: false }
];

/**
 * Dictation settings.
 *
 * Deliberately a single model field rather than a whole `AgentModelConfig`:
 * transcription shares none of a completion's parameters - no max tokens, no
 * temperature, no reasoning - so offering knobs the provider ignores is worse
 * than offering none.
 */
export type AgentVoiceSettings = {
  /** The OpenRouter model id that transcribes dictation. */
  model: string;
};

export const DEFAULT_AGENT_VOICE_SETTINGS: AgentVoiceSettings = {
  model: AGENT_VOICE_MODELS[0].id
};

/**
 * Ask main to transcribe a recorded clip.
 *
 * `cwd` and `branch` are what the recognition hints are spent on: the project
 * folder name and the current branch, added to a fixed list of coding
 * vocabulary so "refactor the AgentThread composer" comes back as those words
 * rather than "agent thread composer".
 */
export type AgentTranscribeRequest = {
  /** The pane's working folder, whose name feeds the recognition hints. */
  cwd: string;
  /** The pane's git branch, or `null` when it is not in a repo. */
  branch: string | null;
  /**
   * The raw audio as base64, with no `data:` prefix. Main sends this straight
   * to OpenRouter's `input_audio.data` field.
   */
  audioBase64: string;
  /** The MediaRecorder mime type, e.g. `audio/webm;codecs=opus`. */
  mimeType: string;
};

/**
 * Whether it worked, as data rather than as a rejection.
 *
 * A clip that fails - offline, rate limited, the key invalid, over the size
 * limit - is an ordinary thing for someone to try, and it wants a line under
 * the composer rather than a thrown exception. The renderer keeps the audio
 * and offers a retry, because a failed request must never destroy what the
 * user said.
 */
export type AgentTranscribeResult = { ok: true; text: string } | { ok: false; error: string };

/** What `mimeType` reduces to for OpenRouter's `format` field. */
export function formatFromMime(mimeType: string): string {
  return mimeType.split(';')[0].split('/').pop() ?? '';
}
