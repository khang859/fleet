import {
  TELEPROMPTER_ACTIONS,
  findAcceleratorConflicts,
  type HotkeyStatus,
  type TeleprompterAction
} from '../../shared/teleprompter';

/** The slice of Electron's `globalShortcut` this needs, so tests can stand in for it. */
export type ShortcutPort = {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
};

/**
 * The teleprompter's system-wide hotkeys.
 *
 * Unregisters only what it registered itself, never `unregisterAll`, so it
 * cannot take away another feature's shortcut.
 */
export class HotkeyRegistry {
  private registered: string[] = [];

  /** @param refusal what a `false` from `register` means on this desktop. */
  constructor(
    private readonly port: ShortcutPort,
    private readonly refusal: 'in-use' | 'portal' = 'in-use'
  ) {}

  /**
   * Replace every hotkey with `hotkeys`, and report how each one went.
   *
   * A failure is reported, never thrown: another app holding the key, an
   * accelerator Electron cannot parse, and a desktop that does not allow
   * global shortcuts at all (some Wayland compositors) all come back as a
   * status the user can see and act on.
   */
  sync(
    hotkeys: Record<TeleprompterAction, string>,
    onAction: (action: TeleprompterAction) => void
  ): HotkeyStatus[] {
    this.clear();
    const conflicts = findAcceleratorConflicts(hotkeys);
    const statuses: HotkeyStatus[] = [];
    for (const action of TELEPROMPTER_ACTIONS) {
      const accelerator = hotkeys[action].trim();
      if (!accelerator) continue;
      if (conflicts.has(action)) {
        statuses.push({ action, accelerator, ok: false, reason: 'duplicate' });
        continue;
      }
      let ok: boolean;
      try {
        ok = this.port.register(accelerator, () => onAction(action));
      } catch {
        statuses.push({ action, accelerator, ok: false, reason: 'invalid' });
        continue;
      }
      if (ok) {
        this.registered.push(accelerator);
        statuses.push({ action, accelerator, ok: true });
      } else {
        statuses.push({ action, accelerator, ok: false, reason: this.refusal });
      }
    }
    return statuses;
  }

  clear(): void {
    for (const accelerator of this.registered) this.port.unregister(accelerator);
    this.registered = [];
  }
}
