import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { fleetHookEntries } from '../../../claude-sessions/hook-installer';
import { claudeJobSettings, evaJobPermissions } from '../job-settings';

const HOOKS = fleetHookEntries('/home/u/.claude');

describe('claudeJobSettings', () => {
  it('gives the same file as before with no mode', () => {
    expect(claudeJobSettings(HOOKS)).toEqual({
      permissions: { deny: ['AskUserQuestion'], disableBypassPermissionsMode: 'disable' },
      editorMode: 'normal',
      hooks: HOOKS
    });
    expect(claudeJobSettings(HOOKS, { hookCommand: '/h/fleet-hook', auto: false })).toEqual({
      permissions: { deny: ['AskUserQuestion'], disableBypassPermissionsMode: 'disable' },
      editorMode: 'normal',
      hooks: HOOKS,
      statusLine: { type: 'command', command: '/h/fleet-hook statusline', padding: 0 }
    });
  });

  it("adds the push and PR denies and the classifier's boundaries in auto mode", () => {
    const settings = claudeJobSettings(HOOKS, { hookCommand: '/h/fleet-hook', auto: true });
    expect(settings).toEqual({
      permissions: {
        deny: [
          'AskUserQuestion',
          'Bash(git push*)',
          'Bash(gh pr create*)',
          'Bash(gh pr merge*)',
          'Bash(gh pr review*)'
        ],
        disableBypassPermissionsMode: 'disable'
      },
      editorMode: 'normal',
      hooks: HOOKS,
      statusLine: { type: 'command', command: '/h/fleet-hook statusline', padding: 0 },
      autoMode: {
        hard_deny: [
          '$defaults',
          'Fleet crew boundary: never push any git branch or tag, and never open, approve, merge or close a pull request. Fleet does these itself after the step.',
          "Fleet crew boundary: never create, write, change or delete any file outside the session's working directory and its --add-dir folders, by any tool or shell command.",
          'Fleet crew boundary: never deploy to production, and never change cloud resources, DNS, secrets or IAM.'
        ]
      }
    });
  });
});

describe('evaJobPermissions', () => {
  it('denies pushes and pull requests, with no allow and no lock', () => {
    expect(parseToml(evaJobPermissions())).toEqual({
      permissions: {
        deny: [
          'bash(git push*)',
          'bash(gh pr create*)',
          'bash(gh pr merge*)',
          'bash(gh pr review*)'
        ]
      }
    });
  });
});
