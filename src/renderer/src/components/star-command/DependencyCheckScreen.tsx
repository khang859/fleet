import type { DepCheckResult } from '../../store/star-command-store'

interface Props {
  status: 'checking' | 'passed' | 'failed'
  results: DepCheckResult[]
}

export function DependencyCheckScreen({ status, results }: Props) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-950 z-10">
      <div className="w-full max-w-sm px-6">
        <div className="mb-6 text-center">
          <span className="text-yellow-400 text-2xl">{'\u2605'}</span>
          <h2 className="text-sm font-semibold text-neutral-200 mt-2">Checking dependencies</h2>
          <p className="text-xs text-neutral-500 mt-1">Verifying required tools before launch</p>
        </div>

        <div className="space-y-3">
          {results.map((dep) => (
            <DepRow key={dep.name} dep={dep} checking={status === 'checking' && !dep.found && results.every((r) => r.found === dep.found)} />
          ))}
          {/* Show placeholder rows while still checking and no results yet */}
          {status === 'checking' && results.length === 0 && (
            <>
              <PlaceholderRow name="claude" />
              <PlaceholderRow name="git" />
              <PlaceholderRow name="gh" />
            </>
          )}
        </div>

        {status === 'failed' && (
          <div className="mt-6 p-3 bg-red-950/40 border border-red-800/40 rounded-lg">
            <p className="text-xs font-medium text-red-300 mb-2">Missing dependencies</p>
            {results
              .filter((d) => !d.found)
              .map((dep) => (
                <div key={dep.name} className="mt-2">
                  <p className="text-[11px] text-neutral-400 font-mono">{dep.installHint}</p>
                </div>
              ))}
            <p className="text-[11px] text-neutral-500 mt-3">
              Install the missing tools and restart Fleet.
            </p>
          </div>
        )}

        {status === 'passed' && (
          <p className="text-xs text-teal-400 text-center mt-5 animate-pulse">
            All systems go — launching Admiral...
          </p>
        )}
      </div>
    </div>
  )
}

function DepRow({ dep }: { dep: DepCheckResult; checking?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-neutral-900 rounded-lg border border-neutral-800">
      <div className="flex items-center gap-2">
        <StatusIcon found={dep.found} />
        <span className="text-sm font-mono text-neutral-200">{dep.name}</span>
        {dep.version && (
          <span className="text-[11px] text-neutral-500 font-mono truncate max-w-[160px]">
            {dep.version}
          </span>
        )}
      </div>
      <span className={`text-[11px] font-medium ${dep.found ? 'text-teal-400' : 'text-red-400'}`}>
        {dep.found ? 'found' : 'missing'}
      </span>
    </div>
  )
}

function PlaceholderRow({ name }: { name: string }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-neutral-900 rounded-lg border border-neutral-800">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-sm font-mono text-neutral-400">{name}</span>
      </div>
      <span className="text-[11px] text-neutral-600">checking...</span>
    </div>
  )
}

function StatusIcon({ found }: { found: boolean }) {
  if (found) {
    return <span className="text-teal-400 text-sm leading-none">{'\u2713'}</span>
  }
  return <span className="text-red-400 text-sm leading-none">{'\u2717'}</span>
}

function Spinner() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin"
      style={{ minWidth: '14px' }}
    />
  )
}
