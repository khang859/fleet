import type { EventBus } from './event-bus';
import type { NotificationLevel } from '../shared/types';

// Permission prompt patterns from Claude Code and similar tools
const PERMISSION_PATTERNS = [
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i
];

// OSC 7 format: ESC ] 7 ; file://[host]/path BEL  or  ESC ] 7 ; file://[host]/path ST
// eslint-disable-next-line no-control-regex
const OSC7_RE = /\x1b\]7;(file:\/\/[^\x07\x1b]+?)(?:\x07|\x1b\\)/g; // used via matchAll (no shared lastIndex)

const CARRY_BUFFER_SIZE = 200;

export class NotificationDetector {
  private eventBus: EventBus;
  private carryBuffers = new Map<string, string>();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    eventBus.on('pane-closed', (event) => {
      this.carryBuffers.delete(event.paneId);
    });
  }

  scan(paneId: string, data: string): void {
    this.checkOSC7(paneId, data);
    this.checkOSC9(paneId, data);
    this.checkOSC777(paneId, data);
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

  private checkPermissionPrompt(paneId: string, data: string): void {
    for (const pattern of PERMISSION_PATTERNS) {
      if (pattern.test(data)) {
        this.emitNotification(paneId, 'permission');
        return;
      }
    }
  }
}
