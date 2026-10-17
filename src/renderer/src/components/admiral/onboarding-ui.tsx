import { AdmiralGlyph } from './AdmiralGlyph';

/** The pieces the Admiral's onboarding screens share: buttons, cards, labels. */

type ButtonKind = 'primary' | 'secondary' | 'ghost';

const BUTTON: Record<ButtonKind, string> = {
  primary:
    'bg-blue-600 font-medium text-white hover:bg-blue-500 disabled:bg-fleet-surface-3 disabled:text-fleet-text-subtle',
  secondary:
    'border border-fleet-border-strong text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text disabled:opacity-50',
  ghost: 'text-fleet-text-muted hover:bg-fleet-surface-2 hover:text-fleet-text disabled:opacity-50'
};

export function OnboardingButton({
  kind = 'secondary',
  size = 'sm',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind;
  size?: 'sm' | 'lg';
}): React.JSX.Element {
  const sizing = size === 'lg' ? 'px-4 py-2 text-[13px]' : 'px-2.5 py-1.5 text-xs';
  return (
    <button
      type="button"
      {...props}
      className={`shrink-0 rounded-md whitespace-nowrap transition active:scale-[0.97] disabled:cursor-default disabled:active:scale-100 focus-ring ${sizing} ${BUTTON[kind]} ${className}`}
    />
  );
}

export type CardTone = 'plain' | 'blue' | 'green' | 'amber';

const CARD_BORDER: Record<CardTone, string> = {
  plain: 'border-fleet-border',
  blue: 'border-blue-500/60',
  green: 'border-green-500/50',
  amber: 'border-amber-500/50'
};

export function OnboardingCard({
  tone = 'plain',
  dashed = false,
  className = '',
  children
}: {
  tone?: CardTone;
  dashed?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={`rounded-lg border bg-fleet-surface p-3.5 ${dashed ? 'border-dashed' : ''} ${CARD_BORDER[tone]} ${className}`}
    >
      {children}
    </section>
  );
}

/** A small uppercase heading, with an optional note after it. */
export function SectionLabel({
  children,
  note,
  tone = 'muted'
}: {
  children: React.ReactNode;
  note?: React.ReactNode;
  tone?: 'muted' | 'amber';
}): React.JSX.Element {
  return (
    <h3 className="text-[11px] font-semibold tracking-[0.04em]">
      <span
        className={
          tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-fleet-text-muted'
        }
      >
        {children}
      </span>
      {note !== undefined && (
        <span className="font-normal tracking-normal text-fleet-text-subtle"> · {note}</span>
      )}
    </h3>
  );
}

/** A line in the Admiral's own voice, at the top of a setup step. */
export function AdmiralSays({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-fleet-border bg-fleet-surface">
        <AdmiralGlyph size={13} />
      </span>
      <p className="pt-0.5 text-[13px] leading-relaxed text-fleet-text">{children}</p>
    </div>
  );
}

/** A choice among a few, the client's current one outlined in blue. */
export function ChoiceButton({
  selected,
  onClick,
  children
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-md border px-2.5 py-1.5 text-xs whitespace-nowrap transition active:scale-[0.97] focus-ring ${
        selected
          ? 'border-blue-500/70 bg-blue-500/10 font-medium text-fleet-text'
          : 'border-fleet-border-strong text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text'
      }`}
    >
      {children}
    </button>
  );
}

export const textInputCls =
  'min-w-0 rounded-md border border-fleet-border-strong bg-fleet-bg px-2.5 py-1.5 text-xs text-fleet-text placeholder:text-fleet-text-subtle outline-none transition focus:border-blue-500/70';
