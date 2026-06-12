import type { EventBus } from './event-bus';
import type { NotificationLevel } from '../shared/types';

// Permission prompt patterns for CLI tools (generic, not CLI-specific)
const PERMISSION_PATTERNS = [
  // Claude Code patterns
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i,
  // Generic CLI patterns
  /\[Y\/n\]\s*$/,
  /\[yes\/no\]\s*$/i,
  /Continue\?\s*$/i,
  /Approve\?\s*$/i,
  /Press Enter to continue/i,
  /Are you sure\?/i,
  /\(yes\/no\)\s*$/i
];

// OSC 7 format: ESC ] 7 ; file://[host]/path BEL  or  ESC ] 7 ; file://[host]/path ST
// eslint-disable-next-line no-control-regex
const OSC7_RE = /\x1b\]7;(file:\/\/[^\x07\x1b]+?)(?:\x07|\x1b\\)/g; // used via matchAll (no shared lastIndex)

// OSC 133;D[;exitcode] — command finished (FinalTerm/shell integration)
// eslint-disable-next-line no-control-regex
const OSC133D_RE = /\x1b\]133;D(?:;(\d+))?\x1b\\/;

const CARRY_BUFFER_SIZE = 200;

// After the user types into a pane, wait this long before deciding the
// permission prompt was answered. If the trigger text reappears within the
// window, it's just a redraw of the still-pending prompt (e.g. arrow-key
// navigation), so the latch stays engaged and we don't re-notify.
const PERMISSION_RESET_GRACE_MS = 400;

type PermissionLatch = {
  // True once we've emitted for the current prompt; suppresses redraw re-emits.
  suppressed: boolean;
  // True if the trigger text reappeared since the last user input.
  matchedSinceInput: boolean;
  resetTimer: ReturnType<typeof setTimeout> | null;
};

export class NotificationDetector {
  private eventBus: EventBus;
  private carryBuffers = new Map<string, string>();
  private permissionLatches = new Map<string, PermissionLatch>();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    eventBus.on('pane-closed', (event) => {
      this.carryBuffers.delete(event.paneId);
      const latch = this.permissionLatches.get(event.paneId);
      if (latch?.resetTimer) clearTimeout(latch.resetTimer);
      this.permissionLatches.delete(event.paneId);
    });
  }

  scan(paneId: string, data: string): void {
    this.checkOSC7(paneId, data);
    this.checkOSC9(paneId, data);
    this.checkOSC777(paneId, data);
    this.checkOSC133(paneId, data);
    this.checkPermissionPrompt(paneId, data);
  }

  private checkOSC7(paneId: string, data: string): void {
    const carry = this.carryBuffers.get(paneId) ?? '';
    const chunk = carry + data;
    let lastMatchEnd = -1;
    for (const match of chunk.matchAll(OSC7_RE)) {
      lastMatchEnd = match.index + match[0].length;
      try {
        const url = new URL(match[1]);
        const cwd = decodeURIComponent(url.pathname);
        if (cwd) {
          this.eventBus.emit('cwd-changed', { type: 'cwd-changed', paneId, cwd, source: 'osc7' });
        }
      } catch {
        // Malformed URL, skip
      }
    }
    const tail = lastMatchEnd === -1 ? chunk : chunk.slice(lastMatchEnd);
    this.carryBuffers.set(paneId, tail.slice(-CARRY_BUFFER_SIZE));
  }

  private emitNotification(paneId: string, level: NotificationLevel): void {
    this.eventBus.emit('notification', {
      type: 'notification',
      paneId,
      level,
      timestamp: Date.now()
    });
  }

  private checkOSC9(paneId: string, data: string): void {
    // Note: OSC 9 is also used by iTerm2 for Growl notifications.
    // Claude Code uses it for task completion. May need tighter matching
    // if false positives arise from other terminal apps.
    if (data.includes('\x1b]9;')) {
      this.emitNotification(paneId, 'info');
    }
  }

  private checkOSC777(paneId: string, data: string): void {
    if (data.includes('\x1b]777;')) {
      this.emitNotification(paneId, 'info');
    }
  }

  private checkOSC133(paneId: string, data: string): void {
    if (data.includes('\x1b]133;C\x1b\\')) {
      this.eventBus.emit('command-started', {
        type: 'command-started',
        paneId,
        timestamp: Date.now()
      });
    }

    const dMatch = OSC133D_RE.exec(data);
    if (dMatch) {
      const exitCode = dMatch[1] ? parseInt(dMatch[1], 10) : 0;
      this.emitNotification(paneId, exitCode === 0 ? 'subtle' : 'error');
    }
  }

  private checkPermissionPrompt(paneId: string, data: string): void {
    for (const pattern of PERMISSION_PATTERNS) {
      if (pattern.test(data)) {
        const latch = this.permissionLatches.get(paneId);
        if (latch) {
          // Mark that the prompt is still on screen (used to decide whether a
          // pending input actually answered it — see onUserInput).
          latch.matchedSinceInput = true;
          if (latch.suppressed) return;
          latch.suppressed = true;
        } else {
          this.permissionLatches.set(paneId, {
            suppressed: true,
            matchedSinceInput: true,
            resetTimer: null
          });
        }
        this.emitNotification(paneId, 'permission');
        return;
      }
    }
  }

  // Called when the user types into a pane. If the permission prompt text stops
  // reappearing shortly after, the prompt was answered — re-arm the latch so the
  // next distinct permission request notifies exactly once.
  onUserInput(paneId: string): void {
    const latch = this.permissionLatches.get(paneId);
    if (!latch?.suppressed) return;

    latch.matchedSinceInput = false;
    if (latch.resetTimer) clearTimeout(latch.resetTimer);
    latch.resetTimer = setTimeout(() => {
      latch.resetTimer = null;
      if (!latch.matchedSinceInput) latch.suppressed = false;
    }, PERMISSION_RESET_GRACE_MS);
  }
}
