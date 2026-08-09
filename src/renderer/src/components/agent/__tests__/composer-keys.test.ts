import { describe, expect, it } from 'vitest';
import {
  PERMISSION_DRAFT_IDLE_MS,
  composerIntent,
  settleDelay,
  type ComposerState
} from '../composer-keys';

/**
 * Two keys, and everything a mistake with either of them costs: a command run
 * without having been read, a turn thrown away, or a message that quietly will
 * not send.
 */

/** Nothing running, nothing pending, nothing typed. */
const IDLE: ComposerState = {
  asking: false,
  streaming: false,
  armed: false,
  voice: false,
  draft: false
};

const enter = { key: 'Enter', shiftKey: false };
const shiftEnter = { key: 'Enter', shiftKey: true };
const escape = { key: 'Escape', shiftKey: false };

describe('composerIntent', () => {
  it('sends on Enter, as it always has', () => {
    expect(composerIntent(enter, IDLE)).toBe('send');
    expect(composerIntent(enter, { ...IDLE, draft: true })).toBe('send');
    expect(composerIntent(enter, { ...IDLE, streaming: true, draft: true })).toBe('send');
  });

  it('leaves Shift+Enter to the newline it has always inserted', () => {
    expect(composerIntent(shiftEnter, IDLE)).toBe('pass');
    expect(composerIntent(shiftEnter, { ...IDLE, asking: true })).toBe('pass');
  });

  it('answers the question when Enter has nothing else it could mean', () => {
    expect(composerIntent(enter, { ...IDLE, asking: true, streaming: true })).toBe('approve');
  });

  /*
   * The case the whole guard exists for. A card can land in the middle of a
   * sentence, and the key that sends that sentence must not have become the key
   * that agrees to a command. It is also what keeps a typed-out `/clear`
   * working while a question is up.
   */
  it('stays the send key while there is a draft to send', () => {
    const asking = { ...IDLE, asking: true, streaming: true };

    expect(composerIntent(enter, { ...asking, draft: true })).toBe('send');
  });

  it('takes two Escapes to stop a turn', () => {
    const running = { ...IDLE, streaming: true };

    expect(composerIntent(escape, running)).toBe('arm');
    expect(composerIntent(escape, { ...running, armed: true })).toBe('interrupt');
  });

  // Escape belongs to whatever else is listening for it - a dialog, a menu -
  // when there is no turn to stop, so it is not taken here.
  it('leaves Escape alone when nothing is running', () => {
    expect(composerIntent(escape, IDLE)).toBe('pass');
    expect(composerIntent(escape, { ...IDLE, armed: true })).toBe('pass');
    expect(composerIntent(escape, { ...IDLE, asking: true })).toBe('pass');
  });

  /*
   * Section 7.2 of the plan: Escape while voice is capturing or transcribing
   * cancels the voice and is consumed, leaving `armed` untouched - a wrong
   * answer costs a moment, a cancelled turn costs minutes and the money that
   * bought them.
   */
  it('gives Escape to voice over the interrupt while voice is active', () => {
    const streaming = { ...IDLE, streaming: true };
    expect(composerIntent(escape, { ...streaming, voice: true })).toBe('voice');
    // The asymmetry that settles the order: arming is NOT touched.
    expect(composerIntent(escape, { ...streaming, armed: false, voice: true })).toBe('voice');
    expect(composerIntent(escape, { ...streaming, armed: true, voice: true })).toBe('voice');
  });

  it('still arms the interrupt when voice is quiet', () => {
    expect(composerIntent(escape, { ...IDLE, streaming: true })).toBe('arm');
  });

  it('has no opinion about ordinary typing', () => {
    expect(composerIntent({ key: 'a', shiftKey: false }, IDLE)).toBe('pass');
    expect(composerIntent({ key: 'ArrowUp', shiftKey: false }, IDLE)).toBe('pass');
    expect(composerIntent({ key: 'Tab', shiftKey: false }, { ...IDLE, asking: true })).toBe('pass');
  });
});

/*
 * "Quiet" is every way the message being written can change, not only the
 * keyboard: `attach` reports here too, so the picker, a drop, a paste and an
 * `@` picked off the menu all push the question back the same way a keystroke
 * does. This function is told the moment of the last one and does not care
 * which it was.
 */
describe('settleDelay', () => {
  it('draws the question at once when the composer is quiet', () => {
    expect(settleDelay(10_000, 0)).toBe(0);
    expect(settleDelay(10_000, 10_000 - PERMISSION_DRAFT_IDLE_MS)).toBe(0);
  });

  it('holds it back for what is left of the quiet period', () => {
    expect(settleDelay(10_000, 9_800)).toBe(PERMISSION_DRAFT_IDLE_MS - 200);
    expect(settleDelay(10_000, 10_000)).toBe(PERMISSION_DRAFT_IDLE_MS);
  });

  // Measured from the last change, not from when the question arrived, so
  // someone still working on their message keeps pushing it back rather than
  // watching it land a fixed second later regardless.
  it('starts the wait again on every change', () => {
    expect(settleDelay(10_000, 9_900)).toBe(PERMISSION_DRAFT_IDLE_MS - 100);
    expect(settleDelay(10_100, 10_050)).toBe(PERMISSION_DRAFT_IDLE_MS - 50);
  });
});
