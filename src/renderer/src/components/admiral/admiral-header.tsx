import type { AgencyRepoRef } from '../../../../shared/agency';
import { AdmiralGlyph } from './AdmiralGlyph';

/** The Admiral pane's top bar during onboarding: the Admiral's name, then the step's own parts. */
export function AdmiralHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-fleet-border bg-fleet-surface px-3">
      <AdmiralGlyph size={15} className="shrink-0" />
      <span className="shrink-0 text-[13px] font-semibold text-fleet-text">Admiral</span>
      {children}
    </header>
  );
}

export function RepoChip({ repo }: { repo: AgencyRepoRef }): React.JSX.Element {
  return (
    <span
      title={repo.root}
      className="max-w-[160px] shrink-0 truncate rounded bg-fleet-surface-2 px-1.5 py-px font-mono text-[11px] text-fleet-text-muted"
    >
      {repo.name}
    </span>
  );
}
