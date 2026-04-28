import { describe, it, expect } from 'vitest';
import { PiAgentManager, posixShellQuote } from '../pi-agent-manager';

describe('posixShellQuote', () => {
  it('single-quotes simple values', () => {
    expect(posixShellQuote('hello')).toBe(`'hello'`);
  });

  it("escapes single quotes via the standard '\\'' sequence", () => {
    expect(posixShellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('passes through values with spaces, $, backticks without interpretation', () => {
    expect(posixShellQuote('$HOME `whoami`')).toBe(`'$HOME \`whoami\`'`);
  });

  it('quotes an empty string to preserve it', () => {
    expect(posixShellQuote('')).toBe(`''`);
  });
});

describe('PiAgentManager.buildLaunchCommand', () => {
  const mgr = new PiAgentManager();

  it('produces an empty envOverrides path starting with quoted Fleet env vars', () => {
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', {});
    expect(
      cmd.startsWith("FLEET_BRIDGE_PORT='8123' FLEET_BRIDGE_TOKEN='tok' FLEET_PANE_ID='pane-1' ")
    ).toBe(true);
  });

  it('prepends envOverrides with POSIX shell-quoting before FLEET_BRIDGE_PORT', () => {
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', {
      AWS_REGION: 'us-east-1',
      AWS_SECRET_ACCESS_KEY: `it's/a/secret`
    });
    expect(cmd).toMatch(
      /^AWS_REGION='us-east-1' AWS_SECRET_ACCESS_KEY='it'\\''s\/a\/secret' FLEET_BRIDGE_PORT='8123'/
    );
  });

  it('quotes shell-sensitive Fleet vars and command paths for shell -c', () => {
    const cmd = mgr.buildLaunchCommand(8123, "tok'; $(touch nope)", 'pane;`id`', {});

    expect(cmd).toContain("FLEET_BRIDGE_TOKEN='tok'\\''; $(touch nope)'");
    expect(cmd).toContain("FLEET_PANE_ID='pane;`id`'");
    expect(cmd).toContain(posixShellQuote(mgr.getBinPath()));
    expect(cmd).toContain(" -e '");
    expect(cmd).not.toContain('"');
  });

  it('serializes envOverrides in stable insertion order', () => {
    const cmd = mgr.buildLaunchCommand(0, '', '', { A: '1', B: '2', C: '3' });
    expect(cmd.indexOf(`A='1'`)).toBeLessThan(cmd.indexOf(`B='2'`));
    expect(cmd.indexOf(`B='2'`)).toBeLessThan(cmd.indexOf(`C='3'`));
  });

  it('prepends unset directives before env assignments', () => {
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', { AWS_PROFILE: 'dev' }, [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY'
    ]);

    expect(
      cmd.startsWith("unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; AWS_PROFILE='dev' ")
    ).toBe(true);
  });

  it('appends --skill flags with POSIX-quoted absolute paths to bundled skills', () => {
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', {});
    // The skills dir resolves via app.getAppPath() in tests (mocked to /tmp/fleet-test-app).
    expect(cmd).toContain("--skill '/tmp/fleet-test-app/resources/pi-skills/code-review'");
    // --skill flags must come after the extension -e flags (the binary path
    // separates them; --skill is part of pi's own argv).
    const dashEIdx = cmd.indexOf(" -e '");
    const dashSkillIdx = cmd.indexOf(" --skill '");
    expect(dashEIdx).toBeGreaterThan(-1);
    expect(dashSkillIdx).toBeGreaterThan(dashEIdx);
  });
});
