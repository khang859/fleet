import { describe, it, expect } from 'vitest';
import { composerKeyAction, type ComposerKeyEvent } from '../composer-keys';

function ev(overrides: Partial<ComposerKeyEvent>): ComposerKeyEvent {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
    streaming: false,
    ...overrides
  };
}

describe('composerKeyAction', () => {
  it('plain Enter sends', () => {
    expect(composerKeyAction(ev({}))).toBe('send');
  });

  it('does not send while composing an IME candidate (isComposing)', () => {
    expect(composerKeyAction(ev({ isComposing: true }))).toBe('ignore');
  });

  it('does not send while composing an IME candidate (keyCode 229)', () => {
    expect(composerKeyAction(ev({ keyCode: 229 }))).toBe('ignore');
  });

  it('Shift+Enter inserts a newline (ignored so browser default runs)', () => {
    expect(composerKeyAction(ev({ shiftKey: true }))).toBe('ignore');
  });

  it('Cmd+Enter always sends', () => {
    expect(composerKeyAction(ev({ metaKey: true }))).toBe('send');
  });

  it('Ctrl+Enter always sends', () => {
    expect(composerKeyAction(ev({ ctrlKey: true }))).toBe('send');
  });

  it('Cmd+Enter still does not send while composing', () => {
    expect(composerKeyAction(ev({ metaKey: true, isComposing: true }))).toBe('ignore');
  });

  it('Escape stops an in-flight stream', () => {
    expect(composerKeyAction(ev({ key: 'Escape', streaming: true }))).toBe('stop');
  });

  it('Escape does nothing when not streaming', () => {
    expect(composerKeyAction(ev({ key: 'Escape', streaming: false }))).toBe('ignore');
  });

  it('other keys are ignored', () => {
    expect(composerKeyAction(ev({ key: 'a' }))).toBe('ignore');
  });
});
