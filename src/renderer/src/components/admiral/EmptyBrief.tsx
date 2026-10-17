/**
 * The lobby before anything has been said: an invitation to brief, in the
 * Admiral's own voice, and where the ideas drawn from the project will be.
 */
export function EmptyBrief(): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-xl font-semibold text-fleet-text">Ready. What should we work on?</h2>
          <p className="text-[13px] text-fleet-text-muted">
            Tell me what you want, like you would tell a person. I write a plan first, and nothing
            starts until you approve it.
          </p>
        </div>
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold tracking-[0.04em] text-fleet-text-muted">
            IDEAS FROM THIS PROJECT
          </h3>
          <div className="rounded-lg border border-dashed border-fleet-border px-3 py-2.5 text-xs text-fleet-text-subtle">
            Ideas from open issues and recent CI runs will show up here. For now, describe the work
            in your own words.
          </div>
        </section>
      </div>
    </div>
  );
}

/** A job's conversation before anything is in it. */
export function EmptyJob({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <span className="text-sm font-medium text-fleet-text-secondary">{title}</span>
      <span className="text-xs text-fleet-text-muted">
        Everything about this job happens in this tab.
      </span>
    </div>
  );
}
