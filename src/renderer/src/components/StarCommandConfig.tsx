import { useState, useEffect, useCallback } from 'react'
import { useStarCommandStore } from '../store/star-command-store'

// ---- Types ----

type SectorRow = {
  id: string
  name: string
  root_path: string
  stack: string | null
  description: string | null
  base_branch: string
  merge_strategy: string
  verify_command: string | null
  lint_command: string | null
  review_mode: string
  worktree_enabled: number
  created_at: string
  updated_at: string
}

type SupplyRoute = {
  id: number
  upstream_sector_id: string
  downstream_sector_id: string
  relationship: string | null
  created_at: string
}

type RetentionStats = {
  tables: Record<string, number>
  dbSizeBytes: number
  dbPath: string
}

type CleanupResult = {
  comms: number
  cargo: number
  shipsLog: number
}

// ---- Sub-components ----

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
      {title}
      {count !== undefined && <span className="ml-1 text-neutral-600">({count})</span>}
    </h3>
  )
}

// ---- Sectors Section ----

function SectorCard({
  sector,
  onRemove,
  onUpdate
}: {
  sector: SectorRow
  onRemove: (id: string) => void
  onUpdate: (id: string, fields: Record<string, unknown>) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-neutral-800 rounded-lg border border-neutral-700 overflow-hidden">
      <button
        className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-neutral-750 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span className="text-sm text-neutral-200 font-mono truncate">{sector.id}</span>
          {sector.stack && (
            <span className="text-xs text-neutral-500 bg-neutral-700 px-1.5 py-0.5 rounded flex-shrink-0">
              {sector.stack}
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-neutral-700 pt-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="text-neutral-500">Name</label>
              <div className="text-neutral-300">{sector.name}</div>
            </div>
            <div>
              <label className="text-neutral-500">Path</label>
              <div className="text-neutral-300 truncate font-mono text-xs">{sector.root_path}</div>
            </div>
            <div>
              <label className="text-neutral-500">Description</label>
              <div className="text-neutral-300">{sector.description ?? 'none'}</div>
            </div>
            <div>
              <label className="text-neutral-500">Base Branch</label>
              <div className="text-neutral-300 font-mono">{sector.base_branch}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="text-neutral-500 block mb-1">Merge Strategy</label>
              <select
                value={sector.merge_strategy}
                onChange={(e) => onUpdate(sector.id, { merge_strategy: e.target.value })}
                className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none"
              >
                <option value="pr">PR</option>
                <option value="direct">Direct</option>
                <option value="squash">Squash</option>
              </select>
            </div>
            <div>
              <label className="text-neutral-500 block mb-1">Review Mode</label>
              <select
                value={sector.review_mode}
                onChange={(e) => onUpdate(sector.id, { review_mode: e.target.value })}
                className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none"
              >
                <option value="admiral-review">Admiral Review</option>
                <option value="auto-merge">Auto Merge</option>
                <option value="manual">Manual</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="text-neutral-500 block mb-1">Verify Command</label>
              <input
                type="text"
                value={sector.verify_command ?? ''}
                placeholder="e.g. npm test"
                onChange={(e) => onUpdate(sector.id, { verify_command: e.target.value || null })}
                className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>
            <div>
              <label className="text-neutral-500 block mb-1">Lint Command</label>
              <input
                type="text"
                value={sector.lint_command ?? ''}
                placeholder="e.g. npm run lint"
                onChange={(e) => onUpdate(sector.id, { lint_command: e.target.value || null })}
                className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-neutral-400">
              <input
                type="checkbox"
                checked={sector.worktree_enabled === 1}
                onChange={(e) => onUpdate(sector.id, { worktree_enabled: e.target.checked })}
                className="rounded"
              />
              Worktrees Enabled
            </label>
          </div>

          <div className="pt-1">
            <button
              onClick={() => onRemove(sector.id)}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-900/20 transition-colors"
            >
              Remove Sector
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SectorsSection() {
  const { sectors, setSectors } = useStarCommandStore()
  const [addPath, setAddPath] = useState('')
  const [addName, setAddName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.fleet.starbase.listSectors().then((s) => setSectors(s as never[]))
  }, [setSectors])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = async () => {
    if (!addPath.trim()) return
    setError(null)
    try {
      await window.fleet.starbase.addSector({
        path: addPath.trim(),
        name: addName.trim() || undefined
      })
      setAddPath('')
      setAddName('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add sector')
    }
  }

  const handleRemove = async (sectorId: string) => {
    try {
      await window.fleet.starbase.removeSector(sectorId)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove sector')
    }
  }

  const handleUpdate = async (sectorId: string, fields: Record<string, unknown>) => {
    try {
      await window.fleet.starbase.updateSector(sectorId, fields)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update sector')
    }
  }

  return (
    <section>
      <SectionHeader title="Sectors" count={(sectors as SectorRow[]).length} />

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1 mb-2">{error}</div>
      )}

      <div className="space-y-2 mb-3">
        {(sectors as SectorRow[]).map((s) => (
          <SectorCard key={s.id} sector={s} onRemove={handleRemove} onUpdate={handleUpdate} />
        ))}
        {sectors.length === 0 && <p className="text-xs text-neutral-600">No sectors registered</p>}
      </div>

      <div className="bg-neutral-800/50 rounded-lg border border-neutral-700 border-dashed p-3 space-y-2">
        <div className="text-xs text-neutral-500 font-semibold">Add Sector</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            placeholder="Path to project directory"
            className="flex-1 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
          />
          <input
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Name (optional)"
            className="w-32 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={!addPath.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>
      </div>
    </section>
  )
}

// ---- Supply Routes Section ----

function SupplyRoutesSection() {
  const { sectors } = useStarCommandStore()
  const [routes, setRoutes] = useState<SupplyRoute[]>([])
  const [graph, setGraph] = useState<Record<string, string[]>>({})
  const [upstream, setUpstream] = useState('')
  const [downstream, setDownstream] = useState('')
  const [error, setError] = useState<string | null>(null)

  const sectorList = sectors as SectorRow[]

  const refresh = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([
        window.fleet.starbase.listSupplyRoutes(),
        window.fleet.starbase.getSupplyRouteGraph()
      ])
      setRoutes(r as SupplyRoute[])
      setGraph(g)
    } catch {
      // services may not be initialized
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAdd = async () => {
    if (!upstream || !downstream) return
    setError(null)
    try {
      await window.fleet.starbase.addSupplyRoute({
        upstreamSectorId: upstream,
        downstreamSectorId: downstream
      })
      setUpstream('')
      setDownstream('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add route')
    }
  }

  const handleRemove = async (routeId: number) => {
    try {
      await window.fleet.starbase.removeSupplyRoute(routeId)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove route')
    }
  }

  // Collect all sector IDs from graph for the visual
  const allNodes = new Set<string>()
  for (const [from, tos] of Object.entries(graph)) {
    allNodes.add(from)
    for (const to of tos) allNodes.add(to)
  }

  return (
    <section>
      <SectionHeader title="Supply Routes" count={routes.length} />

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1 mb-2">{error}</div>
      )}

      {/* Simple directed graph visualization */}
      {allNodes.size > 0 && (
        <div className="bg-neutral-800 rounded-lg border border-neutral-700 p-3 mb-3">
          <div className="text-xs text-neutral-500 mb-2 font-semibold">Dependency Graph</div>
          <div className="space-y-1">
            {Object.entries(graph).map(([from, tos]) =>
              tos.map((to) => (
                <div key={`${from}-${to}`} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-neutral-200 bg-neutral-700 px-1.5 py-0.5 rounded">
                    {from}
                  </span>
                  <span className="text-neutral-500">{'\u2192'}</span>
                  <span className="font-mono text-neutral-200 bg-neutral-700 px-1.5 py-0.5 rounded">
                    {to}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Route list with remove buttons */}
      <div className="space-y-1 mb-3">
        {routes.map((route) => (
          <div
            key={route.id}
            className="flex items-center justify-between bg-neutral-800 rounded px-2 py-1.5 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-neutral-300">{route.upstream_sector_id}</span>
              <span className="text-neutral-500">{'\u2192'}</span>
              <span className="font-mono text-neutral-300">{route.downstream_sector_id}</span>
              {route.relationship && (
                <span className="text-neutral-500">({route.relationship})</span>
              )}
            </div>
            <button
              onClick={() => handleRemove(route.id)}
              className="text-neutral-500 hover:text-red-400 transition-colors px-1"
              title="Remove route"
            >
              {'\u2715'}
            </button>
          </div>
        ))}
        {routes.length === 0 && (
          <p className="text-xs text-neutral-600">No supply routes defined</p>
        )}
      </div>

      {/* Add route */}
      <div className="bg-neutral-800/50 rounded-lg border border-neutral-700 border-dashed p-3 space-y-2">
        <div className="text-xs text-neutral-500 font-semibold">Add Supply Route</div>
        <div className="flex gap-2 items-center">
          <select
            value={upstream}
            onChange={(e) => setUpstream(e.target.value)}
            className="flex-1 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
          >
            <option value="">Upstream sector...</option>
            {sectorList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <span className="text-neutral-500 text-xs">{'\u2192'}</span>
          <select
            value={downstream}
            onChange={(e) => setDownstream(e.target.value)}
            className="flex-1 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
          >
            <option value="">Downstream sector...</option>
            {sectorList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <button
            onClick={handleAdd}
            disabled={!upstream || !downstream}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>
      </div>
    </section>
  )
}

// ---- Starbase Settings Section ----

const CONFIG_FIELDS: {
  key: string
  label: string
  type: 'number' | 'text' | 'password' | 'select'
  options?: string[]
}[] = [
  { key: 'anthropic_api_key', label: 'Anthropic API Key', type: 'password' },
  { key: 'admiral_model', label: 'Admiral Model', type: 'text' },
  { key: 'max_concurrent_worktrees', label: 'Max Concurrent Worktrees', type: 'number' },
  { key: 'worktree_pool_size', label: 'Worktree Pool Size', type: 'number' },
  { key: 'disk_budget_mb', label: 'Disk Budget (MB)', type: 'number' },
  { key: 'mission_timeout_min', label: 'Mission Timeout (min)', type: 'number' },
  {
    key: 'merge_strategy',
    label: 'Default Merge Strategy',
    type: 'select',
    options: ['pr', 'direct', 'squash']
  },
  { key: 'comms_rate_limit_per_min', label: 'Comms Rate Limit (/min)', type: 'number' },
  { key: 'token_budget', label: 'Token Budget', type: 'number' },
  { key: 'lifesign_interval_sec', label: 'Lifesign Interval (sec)', type: 'number' },
  { key: 'lifesign_timeout_sec', label: 'Lifesign Timeout (sec)', type: 'number' },
  {
    key: 'review_mode',
    label: 'Default Review Mode',
    type: 'select',
    options: ['admiral-review', 'auto-merge', 'manual']
  },
  { key: 'review_timeout_min', label: 'Review Timeout (min)', type: 'number' },
  { key: 'comms_retention_days', label: 'Comms Retention (days)', type: 'number' },
  { key: 'cargo_retention_days', label: 'Cargo Retention (days)', type: 'number' },
  { key: 'ships_log_retention_days', label: 'Ships Log Retention (days)', type: 'number' }
]

function StarbaseSettingsSection() {
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    window.fleet.starbase
      .getConfig()
      .then(setConfig)
      .catch(() => {})
  }, [])

  const handleChange = async (key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setSaving(key)
    try {
      await window.fleet.starbase.setConfig(key, value)
    } catch {
      // revert on error
      const fresh = await window.fleet.starbase.getConfig()
      setConfig(fresh)
    }
    setSaving(null)
  }

  return (
    <section>
      <SectionHeader title="Starbase Settings" />
      <div className="bg-neutral-800 rounded-lg border border-neutral-700 p-3">
        <div className="grid grid-cols-2 gap-3">
          {CONFIG_FIELDS.map((field) => (
            <div key={field.key}>
              <label className="text-xs text-neutral-500 block mb-1">
                {field.label}
                {saving === field.key && <span className="text-yellow-400 ml-1">saving...</span>}
              </label>
              {field.type === 'select' ? (
                <select
                  value={(config[field.key] as string) ?? ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
                >
                  {field.options?.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : field.type === 'password' ? (
                <input
                  type="password"
                  defaultValue={(config[field.key] as string) ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== config[field.key]) handleChange(field.key, v)
                  }}
                  placeholder="Not set"
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
                />
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  value={(config[field.key] as number) ?? ''}
                  onChange={(e) =>
                    handleChange(field.key, e.target.value ? Number(e.target.value) : null)
                  }
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
                />
              ) : (
                <input
                  type="text"
                  value={(config[field.key] as string) ?? ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---- Database Section ----

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DatabaseSection() {
  const [stats, setStats] = useState<RetentionStats | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [vacuuming, setVacuuming] = useState(false)
  const [lastCleanup, setLastCleanup] = useState<CleanupResult | null>(null)

  const refresh = useCallback(() => {
    window.fleet.starbase
      .getRetentionStats()
      .then((s) => setStats(s as RetentionStats))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const result = (await window.fleet.starbase.retentionCleanup()) as CleanupResult
      setLastCleanup(result)
      refresh()
    } catch {
      // ignore
    }
    setCleaning(false)
  }

  const handleVacuum = async () => {
    setVacuuming(true)
    try {
      await window.fleet.starbase.retentionVacuum()
      refresh()
    } catch {
      // ignore
    }
    setVacuuming(false)
  }

  return (
    <section>
      <SectionHeader title="Database" />
      <div className="bg-neutral-800 rounded-lg border border-neutral-700 p-3 space-y-3">
        {stats ? (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="text-neutral-500">DB Path</label>
                <div className="text-neutral-300 font-mono truncate text-xs">{stats.dbPath}</div>
              </div>
              <div>
                <label className="text-neutral-500">Size</label>
                <div className="text-neutral-300">{formatBytes(stats.dbSizeBytes)}</div>
              </div>
            </div>

            <div>
              <label className="text-xs text-neutral-500 block mb-1">Row Counts</label>
              <div className="grid grid-cols-4 gap-1">
                {Object.entries(stats.tables).map(([table, count]) => (
                  <div key={table} className="bg-neutral-900 rounded px-2 py-1 text-xs">
                    <div className="text-neutral-500">{table}</div>
                    <div className="text-neutral-200 font-mono">{count}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-neutral-600">Loading database stats...</p>
        )}

        {lastCleanup && (
          <div className="text-xs text-green-400 bg-green-900/20 rounded px-2 py-1">
            Cleaned: {lastCleanup.comms} comms, {lastCleanup.cargo} cargo, {lastCleanup.shipsLog}{' '}
            logs
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-neutral-200 text-xs rounded transition-colors"
          >
            {cleaning ? 'Cleaning...' : 'Clean Now'}
          </button>
          <button
            onClick={handleVacuum}
            disabled={vacuuming}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-neutral-200 text-xs rounded transition-colors"
          >
            {vacuuming ? 'Compacting...' : 'Compact Database'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ---- Main Config Component ----

export function StarCommandConfig() {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div className="text-sm text-neutral-300 font-semibold mb-2">Starbase Configuration</div>
      <SectorsSection />
      <SupplyRoutesSection />
      <StarbaseSettingsSection />
      <DatabaseSection />
    </div>
  )
}
