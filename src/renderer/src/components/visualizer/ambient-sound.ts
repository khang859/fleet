export class AmbientSoundscape {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private oscillator: OscillatorNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private isRunning = false;

  async init(): Promise<void> {
    if (this.ctx) return;

    this.ctx = new AudioContext();
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0;
    this.gainNode.connect(this.ctx.destination);

    // Low frequency drone
    this.oscillator = this.ctx.createOscillator();
    this.oscillator.type = 'sine';
    this.oscillator.frequency.value = 60; // very low hum
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0.3;
    this.oscillator.connect(oscGain);
    oscGain.connect(this.gainNode);
    this.oscillator.start();

    // Filtered white noise for texture
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.noiseSource = this.ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;

    this.noiseFilter = this.ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseFilter.frequency.value = 200;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.1;

    this.noiseSource.connect(this.noiseFilter);
    this.noiseFilter.connect(noiseGain);
    noiseGain.connect(this.gainNode);
    this.noiseSource.start();

    this.isRunning = true;
  }

  setVolume(v: number): void {
    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.1);
    }
  }

  updateActivity(activeCount: number): void {
    if (!this.oscillator || !this.noiseFilter) return;
    // Slightly raise the drone pitch and noise cutoff with more agents
    const freqBoost = Math.min(activeCount * 5, 30);
    this.oscillator.frequency.setTargetAtTime(60 + freqBoost, this.ctx!.currentTime, 0.5);
    this.noiseFilter.frequency.setTargetAtTime(200 + freqBoost * 10, this.ctx!.currentTime, 0.5);
  }

  dispose(): void {
    if (this.oscillator) {
      this.oscillator.stop();
      this.oscillator.disconnect();
    }
    if (this.noiseSource) {
      this.noiseSource.stop();
      this.noiseSource.disconnect();
    }
    if (this.ctx) {
      this.ctx.close();
    }
    this.ctx = null;
    this.gainNode = null;
    this.oscillator = null;
    this.noiseSource = null;
    this.noiseFilter = null;
    this.isRunning = false;
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }
}
