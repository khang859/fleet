/**
 * The sound a pane makes when it starts waiting on the user.
 *
 * Built once, lazily, and shared: two callers now ring it - terminal panes,
 * whose activity comes from main, and agent panes, which know they are blocked
 * without anyone telling them - and a second Audio element would mean a second
 * beep for anything that ever counted as both.
 */

let chime: HTMLAudioElement | null = null;

/** A 440Hz sine for 100ms, as a WAV in memory - no asset to ship or load. */
function build(): HTMLAudioElement {
  const audio = new Audio();
  const sampleRate = 8000;
  const duration = 0.1;
  const samples = sampleRate * duration;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeString(36, 'data');
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) {
    view.setUint8(44 + i, 128 + 64 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }
  audio.src = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  audio.volume = 0.3;
  return audio;
}

/** Ring it. A blocked autoplay policy is not worth failing a notification over. */
export function playChime(): void {
  chime ??= build();
  void chime.play().catch(() => {});
}
