/**
 * Layout primitives shared by every Agent settings pane. They encode the
 * single-column, label-left / control-right convention (NN/g form guidance):
 * tight spacing within a group, generous spacing between groups.
 */

/** A pane header: title + optional one-line description. */
export function SectionShell({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-fleet-text">{title}</h2>
        {description && <p className="mt-1 text-sm text-fleet-text-muted">{description}</p>}
      </header>
      {children}
    </div>
  );
}

/** A spaced cluster of fields, with an optional quiet sub-heading. */
export function FieldGroup({
  title,
  children
}: {
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {title && (
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-fleet-text-subtle">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

/**
 * One setting row. `row` (default) places the control to the right of the
 * label; `stack` puts a full-width control under the label (model pickers,
 * editors, textareas).
 */
export function Field({
  label,
  description,
  htmlFor,
  layout = 'row',
  children
}: {
  label: string;
  description?: React.ReactNode;
  htmlFor?: string;
  layout?: 'row' | 'stack';
  children: React.ReactNode;
}): React.JSX.Element {
  const head = (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="text-sm text-fleet-text-secondary">
        {label}
      </label>
      {description && <p className="mt-0.5 text-xs text-fleet-text-muted">{description}</p>}
    </div>
  );

  if (layout === 'stack') {
    return (
      <div className="space-y-1.5">
        {head}
        {children}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4">
      {head}
      <div className="shrink-0">{children}</div>
    </div>
  );
}
