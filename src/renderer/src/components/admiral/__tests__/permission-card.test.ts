import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyPermission } from '../../../../../shared/agency-permissions';
import { PermissionCard, PermissionLine } from '../PermissionCard';
import { answeredPermissionId } from '../job-view';

/** A permission request as the client answers it, and as the chat records the Admiral's answer. */

const REQUEST: AgencyPermission = {
  id: 4,
  jobId: 2,
  crewId: 1,
  crewLabel: 'qa 1',
  stepId: 'qa-1',
  tool: 'Bash',
  target: './deploy.sh --prod',
  state: 'client',
  answeredBy: null,
  reason: 'A production deploy is outside the plan.',
  summary: 'deploy to production',
  recommend: 'deny',
  createdAt: 0,
  askedAt: Date.now(),
  expiresAt: Date.now() + 180_000,
  answeredAt: null
};

const card = (p: Partial<AgencyPermission>): string =>
  renderToStaticMarkup(
    createElement(PermissionCard, { permission: { ...REQUEST, ...p }, paneId: 'pane-1' })
  );

describe('PermissionCard', () => {
  it('asks with the target, the reason and the expiry, the Admiral’s pick first', () => {
    const out = card({});
    expect(out).toContain('qa 1 asks to deploy to production');
    expect(out).toContain('expires in 3m');
    expect(out).toContain('./deploy.sh --prod');
    expect(out).toContain('A production deploy is outside the plan.');
    expect(out.indexOf('Deny · My pick')).toBeLessThan(out.indexOf('Allow once'));
  });

  it('puts Allow first when the Admiral recommends it', () => {
    const out = card({ recommend: 'allow' });
    expect(out.indexOf('Allow once · My pick')).toBeLessThan(out.indexOf('Deny'));
  });

  it('sends the client to the pane once Fleet stops holding it', () => {
    const out = card({ state: 'in_pane' });
    expect(out).toContain('waits in qa 1&#x27;s pane');
    expect(out).toContain('Peek');
    expect(out).not.toContain('Allow once');
  });

  it('says how an answered card ended', () => {
    expect(card({ state: 'denied', answeredBy: 'expiry' })).toContain(
      'Denied: the card expired before you answered.'
    );
    expect(card({ state: 'allowed', answeredBy: 'client' })).toContain('Allowed by you.');
  });
});

describe('PermissionLine', () => {
  it('reads as the decision, the crew member, the target and the reason', () => {
    const out = renderToStaticMarkup(
      createElement(PermissionLine, {
        permission: { ...REQUEST, target: 'git push origin job/2\nmore' },
        decision: 'allow',
        reason: 'fits step 1'
      })
    );
    expect(out).toContain('Allowed qa 1');
    expect(out).toContain('git push origin job/2<');
    expect(out).toContain('· fits step 1');
  });

  it('is found by the token on the tool row', () => {
    expect(answeredPermissionId({ summary: 'allowed p4 perm#4' })).toBe(4);
    expect(answeredPermissionId({ summary: 'asked the client about p4' })).toBeNull();
  });
});
