import { describe, it, expect } from 'vitest';
import { attentionOf, alertsFor, channelsKeyFor, type NotificationChannels } from '../attention';

const ALL: NotificationChannels = { badge: true, sound: true, os: true };

describe('attentionOf', () => {
  it('is away whenever the window is not focused, wherever the pane is', () => {
    expect(attentionOf({ windowFocused: false, paneVisible: true })).toBe('away');
    expect(attentionOf({ windowFocused: false, paneVisible: false })).toBe('away');
  });

  it('separates the pane in front of the user from one in another tab', () => {
    expect(attentionOf({ windowFocused: true, paneVisible: true })).toBe('here');
    expect(attentionOf({ windowFocused: true, paneVisible: false })).toBe('nearby');
  });
});

describe('alertsFor', () => {
  it('says nothing out loud about a pane the user is looking at', () => {
    expect(alertsFor('here', 'permission', ALL)).toEqual({ chime: false, os: false, badge: true });
  });

  it('chimes for a pane elsewhere in Fleet, without a desktop notification', () => {
    expect(alertsFor('nearby', 'permission', ALL)).toEqual({ chime: true, os: false, badge: true });
  });

  it('rings exactly once when Fleet is in the background', () => {
    // The desktop notification carries its own sound; a chime as well would be
    // two announcements of one question.
    const alerts = alertsFor('away', 'permission', ALL);
    expect(alerts).toEqual({ chime: false, os: true, badge: true });
    expect([alerts.chime, alerts.os].filter(Boolean)).toHaveLength(1);
  });

  it('still chimes in the background when desktop notifications are off but sound is on', () => {
    expect(alertsFor('away', 'permission', { badge: true, sound: true, os: false })).toEqual({
      chime: true,
      os: false,
      badge: true
    });
  });

  it('honours each channel being turned off on its own', () => {
    expect(alertsFor('nearby', 'permission', { badge: false, sound: false, os: true })).toEqual({
      chime: false,
      os: false,
      badge: false
    });
    expect(alertsFor('away', 'permission', { badge: true, sound: true, os: false }).os).toBe(false);
  });

  it('never interrupts for a subtle event, however far away the user is', () => {
    for (const attention of ['here', 'nearby', 'away'] as const) {
      expect(alertsFor(attention, 'subtle', ALL)).toEqual({
        chime: false,
        os: false,
        badge: true
      });
    }
  });

  it('treats a finished turn the same way it treats a question, by distance', () => {
    expect(alertsFor('here', 'info', ALL).chime).toBe(false);
    expect(alertsFor('nearby', 'info', ALL).chime).toBe(true);
    expect(alertsFor('away', 'info', ALL).os).toBe(true);
  });
});

describe('channelsKeyFor', () => {
  it('maps every level to the settings group that speaks for it', () => {
    expect(channelsKeyFor('permission')).toBe('needsPermission');
    expect(channelsKeyFor('error')).toBe('processExitError');
    expect(channelsKeyFor('info')).toBe('taskComplete');
    expect(channelsKeyFor('subtle')).toBe('processExitClean');
  });
});
