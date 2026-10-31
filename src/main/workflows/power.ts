export type PowerApi = {
  /** Electron's `powerSaveBlocker`. */
  blocker: {
    start: (type: 'prevent-app-suspension') => number;
    stop: (id: number) => void;
  };
  /** Electron's `powerMonitor`. */
  monitor: {
    on(event: 'suspend', listener: () => void): unknown;
    on(event: 'resume', listener: () => void): unknown;
    on(event: 'on-battery', listener: () => void): unknown;
    on(event: 'on-ac', listener: () => void): unknown;
    isOnBatteryPower: () => boolean;
  };
};

export type PowerCallbacks = {
  onSuspend: () => void;
  onResume: () => void;
  /** The power source changed, so the hold may need to change. */
  onSourceChange: () => void;
};

/**
 * Keeps the computer awake while an agent works. The screen can still turn off.
 * Only one hold exists at a time, and it goes when every agent waits, when the
 * last run ends, and on battery.
 */
export class WorkflowPower {
  private hold: number | null = null;

  constructor(
    private readonly api: PowerApi,
    private readonly callbacks: PowerCallbacks
  ) {}

  start(): void {
    this.api.monitor.on('suspend', () => this.callbacks.onSuspend());
    this.api.monitor.on('resume', () => this.callbacks.onResume());
    this.api.monitor.on('on-battery', () => this.callbacks.onSourceChange());
    this.api.monitor.on('on-ac', () => this.callbacks.onSourceChange());
  }

  onBattery(): boolean {
    return this.api.monitor.isOnBatteryPower();
  }

  /** Take or release the hold, from whether any agent works now. */
  update(anyAgentWorking: boolean): void {
    const wanted = anyAgentWorking && !this.onBattery();
    if (wanted && this.hold === null) {
      this.hold = this.api.blocker.start('prevent-app-suspension');
    }
    if (!wanted && this.hold !== null) {
      this.api.blocker.stop(this.hold);
      this.hold = null;
    }
  }

  get holding(): boolean {
    return this.hold !== null;
  }
}
