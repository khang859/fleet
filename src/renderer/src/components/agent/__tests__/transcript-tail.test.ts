import { describe, expect, it } from 'vitest';
import { TAIL_SLACK_PX, atTail, lostRoom } from '../transcript-tail';

describe('atTail', () => {
  it('is the end of a transcript scrolled all the way down', () => {
    expect(atTail({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 600 })).toBe(true);
  });

  it('is not the middle of one', () => {
    expect(atTail({ scrollHeight: 2000, scrollTop: 800, clientHeight: 600 })).toBe(false);
  });

  it('is still the end a fractional pixel short of it', () => {
    const short = (by: number): boolean =>
      atTail({ scrollHeight: 2000, scrollTop: 1400 - by, clientHeight: 600 });

    expect(short(TAIL_SLACK_PX)).toBe(true);
    expect(short(TAIL_SLACK_PX + 1)).toBe(false);
  });

  it('is the end of a transcript too short to scroll', () => {
    expect(atTail({ scrollHeight: 600, scrollTop: 0, clientHeight: 600 })).toBe(true);
  });
});

describe('lostRoom', () => {
  const room = { content: 2000, port: 600 };

  it('is the reply arriving', () => {
    expect(lostRoom(room, { ...room, content: 2100 })).toBe(true);
  });

  /*
   * The half that has no scroll event behind it, and the bug this was written
   * for: a permission card's status line appears *under* the transcript, the
   * box loses those pixels off its bottom, and the card the user is being asked
   * to answer ends up just below the fold with nothing having scrolled.
   */
  it('is a line appearing under the transcript', () => {
    expect(lostRoom(room, { ...room, port: 578 })).toBe(true);
  });

  it('is not the pane being made bigger', () => {
    expect(lostRoom(room, { content: 2000, port: 900 })).toBe(false);
  });

  // Someone folding a tool call away, or deleting a draft: the end of the
  // transcript is no further from view than it was.
  it('is not content going away', () => {
    expect(lostRoom(room, { content: 1500, port: 600 })).toBe(false);
  });

  it('is nothing at all when nothing moved', () => {
    expect(lostRoom(room, { ...room })).toBe(false);
  });
});
