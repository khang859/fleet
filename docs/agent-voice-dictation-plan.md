# Agent pane voice dictation - Implementation Plan

> Status: **built, shipping in beta.**
> Requirements are locked (section 3), the architecture in section 5 is what was written, and every edge case in section 8 ships together.
> The one step that cannot be verified from a dev run is the macOS permission prompt: TCC attributes the dev app to whatever launched it, so the prompt only appears for an installed build carrying the entitlement from section 9.

## 1. What this is

Speaking a prompt into the Agent pane instead of typing it.

Hold the mic button, talk, release, and the transcript lands at the caret in the composer you already use.
Nothing is sent automatically.
The message you review and press Enter on is an ordinary message: slash commands, `@` mentions, attachments, and prompt history all work on it unchanged, because voice never becomes a second input path - it only fills the same box.

Text-to-speech is deliberately **out of scope**.
Coding agents answer with code blocks, diffs, and tool-call chatter, none of which is worth listening to, and no harness researched in section 2 speaks replies back by default.

## 2. What other harnesses do

Research findings, recorded because they shaped decisions below.

**Claude Code** shipped native `/voice` in v2.1.69, with tap mode arriving in v2.1.116.
Hold a key or tap to start and stop, and speech is transcribed live into the prompt input so voice and typing can be mixed in one message.
Two details are worth stealing outright.
Transcription is tuned for coding vocabulary - `regex`, `OAuth`, `JSON`, `localhost` - and **the current project name and git branch are added as recognition hints automatically**.
Their changelog also documents the failure modes, which is cheaper to read than to rediscover:

- Voice dictation swallowed spaces and spuriously started recording during very fast typing.
- Voice dictation retried in an unbounded loop when the microphone or recorder failed; repeated capture failures now pause voice input.

**Aider** `/voice` is the simpler shape and the one this plan follows: record a clip with live audio-level feedback, transcribe it, insert it as the prompt.

**Wispr Flow**, **Aqua Voice**, and **SuperWhisper** are the dictation-tool category.
The consistent pattern is transcribe-then-rewrite: raw text passes through a language model that strips filler, fixes punctuation, and formats for the target context.
Aqua trains a proprietary model (Avalon) on developer jargon and keeps a custom dictionary.
This confirms that post-processing a transcript is load-bearing rather than a nicety, and section 5 adopts the cheap version of it.

Nobody in this space speaks agent replies back by default.

## 3. Locked requirements

These were decided explicitly and are not reopened by this plan.

| Decision | Choice |
| --- | --- |
| Scope | Dictation only. No TTS. |
| Engine | OpenRouter cloud only. No local Whisper. |
| Interaction | Press-and-hold for push-to-talk, click to toggle. |
| After transcription | Insert at the caret. Never auto-send. |
| Depth | Full feature. Every edge case in section 8 ships together. |

## 4. Provider landscape

OpenRouter has two dedicated audio endpoints, so **Fleet's existing OpenRouter key covers this feature**.
No new provider account, no new secret class, no new key UI.

- `POST /api/v1/audio/transcriptions` - base64 JSON (`input_audio: {data, format}`) or OpenAI-style multipart up to 25 MB.
- `POST /api/v1/audio/speech` - unused here.

Catalogue prices per hour of audio, for reference:

| Model | Price | Per hour |
| --- | --- | --- |
| NVIDIA Parakeet TDT 0.6B v3 | $0.0015/min | $0.09 |
| Grok STT 1.0 | $0.10/hr | $0.10 |
| Qwen3 ASR Flash | $0.000035/s | $0.13 |
| Mistral Voxtral Mini Transcribe | $0.003/min | $0.18 |
| Deepgram Nova-3 | $0.0043/min | $0.26 |
| OpenAI GPT Transcribe | $0.0045/min | $0.27 |
| Fish Audio Transcribe 1 | $0.0001/s | $0.36 |

At realistic dictation volume - ten or fifteen minutes of actual speech in a day - this is cents per month at any rate in the table.
Cost is not a selection criterion.
Accuracy on identifiers is.

### 4.1 Recognition hints only work through Groq

This is the one finding that constrains the default model.

OpenRouter documents its top-level `prompt` field as **accepted but ignored**.
Vocabulary biasing is available only through provider passthrough:

```json
"provider": { "options": { "groq": { "prompt": "Expected vocabulary: ..." } } }
```

Groq is the only provider documented as supporting it.
Groq serves `openai/whisper-large-v3` and `openai/whisper-large-v3-turbo` on OpenRouter at roughly $0.04/hr, running 10-20x realtime, so a fifteen-second prompt transcribes in about a second.

**Default: `openai/whisper-large-v3-turbo` with the Groq provider pinned.**
The hint budget is spent on the project folder name, the current git branch, and a fixed list of coding vocabulary.
This is what makes "refactor the AgentThread composer" come back as those words rather than "agent thread composer".

The model stays user-changeable.
Choosing a model whose provider does not support hints degrades silently in accuracy, so the settings UI states which models support hints, and `transcribe.ts` logs when hints were dropped.

## 5. Architecture

The renderer captures audio and owns all interaction state.
Main holds the key and makes the HTTP call, exactly as it does for titles.
Nothing about the turn, the transcript, or the session log changes.

```
VoiceButton (pointer/keyboard)
  -> voice-intent.ts        pure: tap vs hold, state transitions
  -> use-voice-dictation.ts getUserMedia, MediaRecorder, AnalyserNode, teardown
  -> AGENT_TRANSCRIBE       invoke, bytes in / text out
  -> transcribe.ts (main)   OpenRouter + key + hints, zod-parsed
  -> insertAtCaret()        into the existing `text` state
```

Audio is **never written to disk**.
Unlike a pasted image, a dictation clip has no second life - the transcript is the artifact worth keeping - so there is no store to build and nothing to sweep on startup.

A multi-megabyte structured clone crosses IPC once per utterance, not per frame.
That is acceptable at this frequency and is the reason the duration cap in section 8 matters.

## 6. Files

### New

| File | Purpose |
| --- | --- |
| `src/shared/agent-voice.ts` | Settings type, request/result types, limits, the curated model list. |
| `src/main/agent/transcribe.ts` | The OpenRouter transcription call, hint assembly, zod parsing. |
| `src/renderer/src/components/agent/voice-intent.ts` | Pure decision logic: tap vs hold, state machine, Escape precedence. |
| `src/renderer/src/components/agent/use-voice-dictation.ts` | Capture, level metering, teardown, failure backoff. |
| `src/renderer/src/components/agent/VoiceButton.tsx` | The control and its seven states. |
| `src/renderer/src/components/agent/__tests__/voice-intent.test.ts` | Unit tests for the pure logic. |
| `src/main/agent/__tests__/transcribe.test.ts` | Unit tests for request shape, parsing, and error mapping. |

### Modified

| File | Change |
| --- | --- |
| `build/entitlements.mac.plist` | Add `com.apple.security.device.audio-input`. |
| `electron-builder.yml` | Add `mac.extendInfo.NSMicrophoneUsageDescription`. |
| `src/main/index.ts` | `setPermissionRequestHandler` granting only `media` to the app's own window. |
| `src/shared/ipc-channels.ts` | `AGENT_TRANSCRIBE: 'agent:transcribe'`. |
| `src/shared/agent-types.ts` | `voice: AgentVoiceSettings` on `AgentSettings`, plus its default. |
| `src/main/settings-store.ts` | A `voice` merge branch in both `get()` and `set()`. |
| `src/main/agent/agent-ipc.ts` | The `AGENT_TRANSCRIBE` handler. |
| `src/preload/index.ts` | `agent.transcribe(...)` on the bridge. |
| `src/renderer/src/components/agent/AgentThread.tsx` | Mount `VoiceButton`, insert at caret, extend the Escape path. |
| `src/renderer/src/components/agent/settings/AgentSettingsPanel.tsx` | The voice settings block. |

Settings ride the generic `SETTINGS_GET`/`SETTINGS_SET`, so no new settings channel is added.

## 7. The state machine

Seven states, one transition table, all of it in `voice-intent.ts` so it can be tested without a browser - the same reasoning that put `composerIntent` in `composer-keys.ts`.

| State | Meaning | Control | Composer |
| --- | --- | --- | --- |
| `idle` | Ready | Mic glyph, muted, matching the paperclip | Placeholder unchanged |
| `requesting` | Waiting on the OS prompt | Dimmed, non-interactive | Unchanged |
| `recording` | Capturing | Filled accent circle | Level meter and elapsed time replace the placeholder |
| `transcribing` | Waiting on the API | Quiet indeterminate indicator | Caret stays live, typing still allowed |
| `error` | Last attempt failed | Amber mic | `Notice` carries the reason |
| `denied` | Blocked at the OS | Mic with a slash | `Notice` explains how to unblock |
| `unavailable` | No key, or no input device | Hidden | Unchanged |

The control is hidden rather than disabled in `unavailable`, because a control that can never do anything is worse than no control.

### 7.1 Tap versus hold

A pointer press shorter than `VOICE_TAP_MAX_MS` (250 ms) is a **tap**, which toggles recording on and leaves it on.
A longer press is a **hold**, which records until release.
The threshold lives in `voice-intent.ts` and is the single place that discrimination is made.

Hold is a pointer affordance only.
Keyboard users get toggle semantics under Space and Enter when the button is focused, because a press-and-hold gesture has no honest keyboard equivalent.
Both routes drive the same state machine, so neither is a second-class path.

While a hold is in progress the composer shows **"Release to insert · move away to discard"**, and moving the pointer off the button genuinely cancels.
This is lifted from DeepSeek's "Release to send, slide up to cancel", which teaches commit and abort at the moment the user's finger is already down.
It also converts pointer-leaves-the-button from an ambiguous bug into a documented feature.

### 7.2 Escape precedence

Escape already means two things: arm an interrupt, then cancel the turn, and only while a turn is streaming.
Voice needs a third.
The order:

1. Recording or transcribing → cancel voice, consume the key, leave `armed` untouched.
2. Otherwise → today's behaviour, unchanged.

Voice is checked first because cancelling a recording is cheap while cancelling a turn throws away minutes of work and the money that bought them.
The asymmetry in what a wrong answer costs is what settles the order, not recency.

### 7.3 Keyboard shortcut

`Cmd+Shift+V` toggles recording in the focused pane.

Deliberately not a hold key.
In a textarea any printable hold key collides with typing, which is precisely the bug Claude Code had to patch when dictation started swallowing spaces during fast typing.
A pointer-based hold plus a chord toggle sidesteps that class entirely.

## 8. Edge cases

All of these ship together.
Severity is what a wrong answer costs: silent data loss and stuck states rank above cosmetic wrong-looks.

### 8.1 Permission and device

| Trigger | Behaviour | Severity |
| --- | --- | --- |
| Never asked before | OS prompt once; a denial is remembered rather than re-prompted on every click | High |
| Denied in System Settings | Distinguished from never-asked via `systemPreferences.getMediaAccessStatus()`; copy says "unblock in Settings", because the in-app prompt will never appear again | High |
| Revoked mid-session | Next attempt re-reads status rather than trusting a cached grant | Medium |
| No input device | Control hidden with a reason; never a silent no-op | Medium |
| Device unplugged mid-recording | Track `ended` fires, recording stops, whatever audio exists is transcribed rather than discarded | **Critical** |
| Bluetooth profile switch | Sample rate changes mid-stream must not produce a corrupt container | Medium |
| Mic held by another app | `NotReadableError` surfaced as "another app is using the microphone" | Medium |

### 8.2 Lifecycle and concurrency

`AgentPane.tsx:173` renders `{view === 'agent' && <AgentThread …/>}`, so **switching to the Sessions or Settings tab unmounts the composer outright**.
This is not an exotic path: Settings is where the voice model picker lives, so "record, go check the model, come back" is a route a user walks on their first day.

| Trigger | Behaviour | Severity |
| --- | --- | --- |
| Tab switch while recording | Unmount stops tracks, closes the context, aborts the request | **Critical** |
| Transcript returns after unmount | Dropped without a state update on a dead component | **Critical** |
| Two panes recording at once | Permitted; each owns its own stream, and one stopping must not stop the other | High |
| App quit or window closed while recording | Tracks released so the OS mic indicator clears | High |
| StrictMode double-mount | Effects must not open two streams; follow the module-level guard the PTY code already uses | High |
| Sleep and wake mid-recording | Treated as ended rather than resumed from a stale stream | Medium |
| Recording during a streaming turn | Allowed; dictating the next message while a turn runs is normal | Medium |

### 8.3 Composer interaction

| Trigger | Behaviour | Severity |
| --- | --- | --- |
| Escape while recording during a streaming turn | Cancels the recording only; the turn is untouched and the interrupt stays unarmed | **Critical** |
| Message sent while transcription is in flight | Transcript discarded, not injected into the next empty box | **Critical** |
| Caret moved or text typed during transcription | Inserts at the caret's current position, never a stale offset | High |
| Text selected when the transcript lands | Replaces the selection, matching ordinary typing | Medium |
| Permission card arrives mid-recording | Recording counts as drafting, so the card waits exactly as it does for typing and attaching | High |
| Slash or mention menu open on insert | Query match re-runs, or the menu dismisses; it must not point at a stale token | Medium |
| `Cmd+Z` after insertion | Restores the pre-insert text, which requires `document.execCommand('insertText')` rather than a bare `setState` | Medium |

### 8.4 Audio content and network

| Trigger | Behaviour | Severity |
| --- | --- | --- |
| Accidental click under 250 ms | Treated as a toggle, not a zero-length clip sent for transcription | High |
| Silence or near-silence | Detected locally from the level meter; the request is skipped entirely | High |
| Whisper hallucination on silence | Known failure mode - confident text from nothing. The silence gate above is the mitigation. | High |
| Recording runs long | `VOICE_MAX_MS` cap with a visible countdown as it approaches, then auto-stop | High |
| Clip over 25 MB | Refused before upload, as data rather than a throw, following the attachment precedent | Medium |
| Offline or timeout | Audio kept and retry offered; a failed request must not destroy what was said | **Critical** |
| 401 / 402 / 429 | Mapped to distinct messages: bad key, out of credits, rate limited | Medium |
| Groq unavailable, request falls elsewhere | Hints silently stop applying; logged, and the settings UI marks which models support them | Medium |
| Malformed response | Zod-parsed; a parse failure is an error, never `undefined` pasted into the box | Medium |

## 9. Build and permission changes

Three changes, all required before anything is testable in a packaged build.

`build/entitlements.mac.plist` gains:

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
```

`electron-builder.yml` gains a `mac.extendInfo` block carrying `NSMicrophoneUsageDescription`.
Without it a hardened-runtime, notarized build cannot legally prompt for the microphone.

`src/main/index.ts` gains a permission request handler.
Electron's default denies `getUserMedia` outright, so this must be explicit, and it grants only `media` and only to the app's own window - deny-by-default is preserved for everything else.

## 10. Tests

Following the repo's existing split: pure logic is unit-tested, I/O is tested through injected fakes.

`voice-intent.test.ts` covers tap versus hold at the threshold boundary, every state transition including the illegal ones, and the Escape precedence table from 7.2 - particularly that Escape while recording during a streaming turn leaves `armed` untouched.

`transcribe.test.ts` covers request shape (raw base64 with no `data:` prefix, provider block present when the model supports hints and absent when it does not), hint assembly from folder name and branch, zod rejection of a malformed body, and the mapping of 401/402/429/500 to distinct messages.

Run with `npm test`, never `npx vitest run` - after `npm run dev` the sqlite addon is built for Electron's ABI and a direct vitest invocation produces hundreds of phantom failures.

## 11. Build sequence

Each step has a check that must pass before the next begins.

1. Entitlement, `extendInfo`, permission handler → `getUserMedia` resolves in dev and the OS mic indicator appears.
2. `agent-voice.ts` types and constants, `AgentSettings.voice`, settings-store merge branches → a stored setting survives a restart.
3. `voice-intent.ts` and its tests → `npm test`.
4. `transcribe.ts`, the IPC channel, the handler, the preload bridge, and its tests → a fixture clip round-trips to text.
5. `use-voice-dictation.ts` and `VoiceButton.tsx` → hold, speak, release, and text appears at the caret, verified with `npm run drive`.
6. `AgentThread.tsx` wiring, Escape precedence, `Cmd+Shift+V` → the section 8.3 cases behave.
7. Settings panel block → model choice and hint support are legible.
8. `npm run typecheck && npm run lint && npm test`, then an end-to-end pass over the section 8 matrix.

## 12. Open questions

**Default model.**
This plan assumes `openai/whisper-large-v3-turbo` pinned to Groq, for the hints in 4.1.
Fish Audio Transcribe 1 is the alternative - automatic language detection and word-level timestamps, but no vocabulary biasing.

**Level meter thresholds.**
What RMS counts as silence, and over what window, needs tuning against a real microphone rather than being guessed here.
