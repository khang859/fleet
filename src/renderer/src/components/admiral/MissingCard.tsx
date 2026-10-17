import { useState } from 'react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type { SetupScan } from '../../../../shared/agency-projects';
import { OnboardingButton, OnboardingCard, SectionLabel } from './onboarding-ui';

/**
 * Submodules `.gitmodules` lists that are not checked out: setup cannot read
 * them until they are. Checking one out is the one git write setup makes,
 * and only on the client's click.
 */
export function MissingCard({
  repo,
  scan,
  onCheckedOut
}: {
  repo: AgencyRepoRef;
  scan: SetupScan;
  onCheckedOut: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkOut = (path: string): void => {
    setBusy(path);
    setError(null);
    window.fleet.agency.projects
      .checkOutMember({ repo, path })
      .then(onCheckedOut)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };
  return (
    <OnboardingCard tone="amber">
      <SectionLabel tone="amber" note="setup could not read these">
        NOT CHECKED OUT
      </SectionLabel>
      <p className="mt-2 text-xs text-fleet-text-secondary">
        Check a submodule out to set it up, or leave it out of the project in the picker.
      </p>
      <ul className="mt-2 flex flex-col">
        {scan.missing.map((m) => (
          <li key={m.path} className="flex min-h-9 items-center gap-3 py-1">
            <span className="text-xs text-fleet-text">{m.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fleet-text-subtle">
              {m.path}
            </span>
            <OnboardingButton disabled={busy !== null} onClick={() => checkOut(m.path)}>
              {busy === m.path ? 'Checking out…' : 'Check out'}
            </OnboardingButton>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {error}
        </p>
      )}
    </OnboardingCard>
  );
}
