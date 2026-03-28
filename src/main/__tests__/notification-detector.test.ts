import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationDetector } from '../notification-detector';
import { EventBus } from '../event-bus';

describe('NotificationDetector', () => {
  let eventBus: EventBus;
  let detector: NotificationDetector;

  beforeEach(() => {
    eventBus = new EventBus();
    detector = new NotificationDetector(eventBus);
  });

  it('detects OSC 9 task completion and emits info notification', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'some output\x1b]9;task done\x07more output');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        paneId: 'pane-1',
        level: 'info'
      })
    );
  });

  it('detects OSC 777 notification', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'output\x1b]777;notify;title;body\x07rest');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        paneId: 'pane-1',
        level: 'info'
      })
    );
  });

  it('detects Claude Code permission prompts', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Do you want to allow this action? (y/n)');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification',
        paneId: 'pane-1',
        level: 'permission'
      })
    );
  });

  it('does not emit for unrecognized output', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'regular terminal output here');

    expect(callback).not.toHaveBeenCalled();
  });

  it('detects generic [Y/n] permission prompt', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Overwrite file? [Y/n] ');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'permission' })
    );
  });

  it('detects "Are you sure?" prompt', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Are you sure? ');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'permission' })
    );
  });

  it('detects "Continue?" prompt', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'Continue? ');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'permission' })
    );
  });

  it('detects OSC 133;D command completion with exit code 0', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', '\x1b]133;D;0\x1b\\');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'subtle' })
    );
  });

  it('detects OSC 133;D command completion with non-zero exit code', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', '\x1b]133;D;1\x1b\\');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', level: 'error' })
    );
  });

  it('detects OSC 133;C command execution start', () => {
    const callback = vi.fn();
    eventBus.on('command-started', callback);

    detector.scan('pane-1', '\x1b]133;C\x1b\\');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1' })
    );
  });

  it('does not emit notification for tmux DCS sequences', () => {
    const callback = vi.fn();
    eventBus.on('notification', callback);

    detector.scan('pane-1', 'output\x1bPtmux;\x1b\x1b]stuff\x07\x1b\\rest');

    // tmux DCS is not a notification — tmux label detection is a Layer 1 sidebar concern
    expect(callback).not.toHaveBeenCalled();
  });
});
