import { describe, it, expect } from 'vitest';
import { fleetRcContents, rcAppendCommand, FLEET_OSC_CODE, FLEET_RC_VERSION } from '../rc-snippet';

describe('fleetRcContents', () => {
  const script = fleetRcContents();

  // checkRcInstalled reads exactly this line to decide whether the host is
  // current, so the shape of it is load-bearing.
  it('starts with the version banner the installer checks for', () => {
    expect(script.split('\n')[0]).toBe(`# fleet-shell-integration v${FLEET_RC_VERSION}`);
  });

  it('reports the working directory on every prompt, in both shells', () => {
    expect(script).toContain("printf '\\033]7;file://%s%s\\033\\\\'");
    expect(script).toContain('add-zsh-hook precmd __fleet_osc7');
    expect(script).toContain('PROMPT_COMMAND');
  });

  it('emits Fleet\u2019s own code for a download request', () => {
    expect(script).toContain(`printf '\\033]${FLEET_OSC_CODE};get;%s\\033\\\\'`);
  });

  it('strips the line wrapping GNU base64 adds', () => {
    expect(script).toContain("base64 | tr -d '\\n'");
  });

  it('refuses a path that is not a file rather than asking Fleet for it', () => {
    expect(script).toContain('if [ ! -f "$__fleet_f" ]; then');
  });
});

describe('rcAppendCommand', () => {
  const command = rcAppendCommand();

  it('is a single line, so ssh cannot mangle it', () => {
    expect(command).not.toContain('\n');
  });

  it('skips a file that already sources the snippet', () => {
    expect(command).toContain('grep -qF .fleetrc.sh "$f" ||');
  });

  it('creates .bashrc only when neither rc file took the line', () => {
    expect(command).toContain('grep -qsF .fleetrc.sh "$HOME/.bashrc" "$HOME/.zshrc" ||');
  });

  // The whole point of the fixed string: nothing user- or remote-supplied is
  // interpolated, so this adds no new call site to ssh-quote's boundary.
  it('interpolates nothing', () => {
    expect(command).toContain('[ -f "$HOME/.fleetrc.sh" ] && . "$HOME/.fleetrc.sh"');
  });
});
