import { useCallback, useEffect, useRef, useState } from 'react'
import type { SystemDepResult } from '../../../shared/ipc-api'

interface Props {
  onDismiss: () => void
}

const DEP_NAMES = ['node', 'claude', 'git', 'gh', 'fleet', 'fleet.sock']

export function AppPreChecks({ onDismiss }: Props) {
  const [status, setStatus] = useState<'checking' | 'passed' | 'failed'>('checking')
  const [results, setResults] = useState<SystemDepResult[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  const runCheck = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setStatus('checking')
    setResults([])

    window.fleet.system.check().then((res) => {
      setResults(res)
      const allFound = res.every((d) => d.found)
      setStatus(allFound ? 'passed' : 'failed')

      if (allFound) {
        timerRef.current = setTimeout(() => onDismissRef.current(), 1000)
      }
    }).catch(() => {
      setStatus('failed')
    })
  }, [])

  useEffect(() => {
    runCheck()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-neutral-950">
      <div className="w-full max-w-sm px-6">
        <div className="mb-6 text-center">
          <span className="text-yellow-400 text-2xl">{'\u2605'}</span>
          <h2 className="text-sm font-semibold text-neutral-200 mt-2">System Check</h2>
          <p className="text-xs text-neutral-500 mt-1">Verifying required tools</p>
        </div>

        <div className="space-y-3">
          {status === 'checking' && results.length === 0
            ? DEP_NAMES.map((name) => <PlaceholderRow key={name} name={name} />)
            : results.map((dep) => <DepRow key={dep.name} dep={dep} />)
          }
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
              Install the missing tools and restart Fleet, or continue without them.
            </p>
          </div>
        )}

        {status === 'failed' && (
          <div className="mt-4 flex gap-2">
            <button
              onClick={runCheck}
              className="flex-1 py-2 text-xs font-medium text-neutral-200 hover:text-white bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded-lg transition-colors"
            >
              Retry
            </button>
            <button
              onClick={onDismiss}
              className="flex-1 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors"
            >
              Continue anyway
            </button>
          </div>
        )}

        {status === 'passed' && (
          <p className="text-xs text-teal-400 text-center mt-5 animate-pulse">
            All systems ready
          </p>
        )}
      </div>
    </div>
  )
}

function DepRow({ dep }: { dep: SystemDepResult }) {
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
