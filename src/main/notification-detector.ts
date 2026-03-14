import { EventBus } from './event-bus';
import type { NotificationLevel } from '../shared/types';

// Permission prompt patterns from Claude Code and similar tools
const PERMISSION_PATTERNS = [
  /Do you want to (?:allow|proceed|continue)/i,
  /\(y\/n\)\s*$/,
  /Allow this action\?/i,
  /Press Enter to confirm/i,
];

export class NotificationDetector {
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  scan(paneId: string, data: string): void {
    this.checkOSC9(paneId, data);
    this.checkOSC777(paneId, data);
    this.checkPermissionPrompt(paneId, data);
  }

  private emitNotification(paneId: string, level: NotificationLevel): void {
    this.eventBus.emit('notification', {
      type: 'notification',
      paneId,
      level,
      timestamp: Date.now(),
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
