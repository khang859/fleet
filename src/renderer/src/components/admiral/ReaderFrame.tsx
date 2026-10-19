import { Section } from './JobSheet';

/**
 * The Bridge reader's layout in the main column: the reader's own header,
 * the item's content scrolling under it, and the item's actions in a footer
 * that stays in view however long the content is.
 */
export function ReaderFrame({
  head,
  footer,
  children
}: {
  head: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-fleet-border px-5 py-2.5">{head}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-5 py-5">{children}</div>
      </div>
      {footer !== undefined && (
        <div className="shrink-0 border-t border-fleet-border bg-fleet-surface">
          <div className="mx-auto flex max-w-[760px] flex-col gap-2 px-5 py-3">{footer}</div>
        </div>
      )}
    </div>
  );
}

/** A titled part of a reader's content, its label written as a sentence. */
export function ReaderSection({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return <Section label={label.toUpperCase()}>{children}</Section>;
}

/** The key that presses a reader button, shown on it; screen readers get `aria-keyshortcuts`. */
export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd
      aria-hidden
      className="ml-1.5 rounded border border-current/25 px-1 font-sans text-[10px] leading-4 opacity-70"
    >
      {children}
    </kbd>
  );
}
