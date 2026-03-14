import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationDetector } from '../notification-detector';
import { EventBus } from '../event-bus';

describe('NotificationDetector — extended', () => {
  let eventBus: EventBus;
  let detector: NotificationDetector;

  beforeEach(() => {
    eventBus = new EventBus();
    detector = new NotificationDetector(eventBus);
  });

  describe('permission pattern coverage', () => {
    it('detects "Do you want to proceed" prompt', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'Do you want to proceed with this operation?');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ level: 'permission' }));
    });

    it('detects "Do you want to continue" prompt', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'Do you want to continue?');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ level: 'permission' }));
    });

    it('detects standalone (y/n) prompt', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'Overwrite existing file? (y/n)');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ level: 'permission' }));
    });

    it('detects "Allow this action?" prompt', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'Allow this action?');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ level: 'permission' }));
    });

    it('detects "Press Enter to confirm" prompt', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'Press Enter to confirm');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ level: 'permission' }));
    });

    it('is case-insensitive for permission patterns', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'DO YOU WANT TO ALLOW THIS?');
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ level: 'permission' }));
    });
  });

  describe('multiple detections in single chunk', () => {
    it('emits both info and permission when OSC and prompt appear together', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);

      // A single data chunk containing both an OSC 9 sequence and a permission prompt
      detector.scan('p1', '\x1b]9;done\x07\nDo you want to allow this? (y/n)');

      const levels = cb.mock.calls.map((c) => c[0].level);
      expect(levels).toContain('info');
      expect(levels).toContain('permission');
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('emits two info events when both OSC 9 and OSC 777 appear', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);

      detector.scan('p1', 'output\x1b]9;task\x07middle\x1b]777;notify;t;b\x07end');

      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls.every((c) => c[0].level === 'info')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty string without emitting', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', '');
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not false-positive on partial OSC sequences', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      // \x1b] without the 9; following it
      detector.scan('p1', 'text \x1b]0;window title\x07 more text');
      expect(cb).not.toHaveBeenCalled();
    });

    it('does not false-positive on "want to" in normal prose', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      detector.scan('p1', 'I want to allow more memory for this process');
      // "want to allow" alone should not match — requires "Do you want to allow"
      expect(cb).not.toHaveBeenCalled();
    });

    it('scans different paneIds independently', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);

      detector.scan('p1', '\x1b]9;done\x07');
      detector.scan('p2', 'Do you want to allow this? (y/n)');

      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[0][0].paneId).toBe('p1');
      expect(cb.mock.calls[0][0].level).toBe('info');
      expect(cb.mock.calls[1][0].paneId).toBe('p2');
      expect(cb.mock.calls[1][0].level).toBe('permission');
    });

    it('includes a timestamp in emitted events', () => {
      const cb = vi.fn();
      eventBus.on('notification', cb);
      const before = Date.now();
      detector.scan('p1', '\x1b]9;done\x07');
      const after = Date.now();

      const ts = cb.mock.calls[0][0].timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });
});
