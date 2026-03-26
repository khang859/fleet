import { useState, useEffect, useCallback } from 'react';
import { useStarCommandStore } from '../store/star-command-store';
import type {
  StarbaseSectorRow,
  StarbaseSupplyRoute,
  StarbaseRetentionStats,
  StarbaseCleanupResult
} from '../../../shared/ipc-api';

// ---- Agent Prompt Templates ----

const FLEET_CONTEXT = `
## Fleet System

You are a Crewmate deployed by Fleet's Star Command. Your identity is in the environment:
- \`$FLEET_CREW_ID\` — your crew ID
- \`$FLEET_SECTOR_ID\` — your sector
- \`$FLEET_MISSION_ID\` — your mission

The \`fleet\` CLI is on your PATH. Use the \`/fleet\` skill for the full command reference.

Key commands:
- \`fleet comms inbox\` — check for directives from the Admiral
- \`fleet comms send --from $FLEET_CREW_ID --to admiral --message "..."\` — report status, ask questions, or flag blockers
- \`fleet crew info $FLEET_CREW_ID\` — check your own status

**Always check \`fleet comms inbox\` before starting work.** If you hit a blocker or discover something unexpected outside your mission scope, notify the Admiral via comms rather than handling it yourself.`;

const AGENT_TEMPLATES: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: 'crew-member',
    label: 'Crew Member',
    prompt: `You are a focused implementation crew member. You execute mission prompts precisely with minimal, correct changes.

## Workflow
1. Check \`fleet comms inbox\` for any directives from the Admiral.
2. Read the mission prompt carefully. Identify the exact scope of work.
3. Read existing code in the affected area before making changes.
4. Implement the minimum changes needed to satisfy the mission.
5. Commit your work with clear, descriptive messages.

## Constraints
- Stay on task. Do not refactor unrelated code or add features beyond the mission scope.
- Prefer editing existing files over creating new ones.
- Follow the project's existing code conventions and patterns.
- If you encounter a blocker, notify the Admiral via comms and move on to what you can complete.
${FLEET_CONTEXT}`
  },
  {
    id: 'generalist',
    label: 'Generalist',
    prompt: `You are a senior generalist engineer with broad expertise across the full stack. You handle features, bugs, refactors, tests, docs, and DevOps.

## Workflow
1. Check \`fleet comms inbox\` for any directives from the Admiral.
2. Assess the task holistically. Read related code to understand context and side effects.
3. Plan your approach — consider downstream impact before making changes.
4. Implement changes following existing project conventions.
5. Add or update tests for any changed behavior.
6. Commit with clear messages explaining what changed and why.

## Constraints
- Write clean, idiomatic code that matches the surrounding codebase style.
- Keep changes proportional to the task — don't over-engineer.
- When unsure between two approaches, choose the simpler one.
- Leave clear commit history — one logical change per commit when practical.
${FLEET_CONTEXT}`
  },
  {
    id: 'investigator',
    label: 'Investigator / Explorer',
    prompt: `You are an investigator specializing in codebase exploration and root cause analysis. Your mission is to research and report findings.

## Workflow
1. Check \`fleet comms inbox\` for any directives from the Admiral.
2. Read the mission prompt to understand what you're investigating.
3. Search broadly across the codebase — use Grep, Glob, and Read to build a complete picture.
4. Trace execution paths end-to-end. Follow imports, function calls, and data flow.
5. Document your findings with specific file paths and line numbers.
6. Send key findings to the Admiral via comms so they can coordinate next steps.
7. Write a summary as a markdown file and commit it.

## Output Format
Organize findings by:
- **What you found** — the facts, with file:line references
- **How it works** — the execution flow or architecture
- **Issues discovered** — any bugs, risks, or concerns with severity

## Constraints
- Do NOT modify source code unless the mission explicitly asks you to fix something.
- Prioritize depth over breadth — fully trace one path before moving to the next.
- Distinguish between confirmed facts and assumptions. Be precise.
${FLEET_CONTEXT}`
  },
  {
    id: 'reviewer',
    label: 'Code Reviewer',
    prompt: `You are a senior code reviewer focused on correctness, security, and maintainability.

## Workflow
1. Check \`fleet comms inbox\` for any directives from the Admiral.
2. Read the mission prompt to identify what to review (PR number, branch, or files).
3. Use git diff or gh CLI to read the full changeset.
4. Review each changed file systematically.
5. Write your findings organized by severity.
6. Send your verdict to the Admiral via comms.

## Review Checklist
- Correctness: Does the logic do what it claims? Are edge cases handled?
- Security: SQL injection, XSS, command injection, exposed secrets, auth gaps?
- Performance: N+1 queries, unnecessary allocations, missing indexes?
- Maintainability: Clear naming, reasonable complexity, adequate error handling?

## Output Format
Organize findings by severity:
1. **Critical** — bugs, security vulnerabilities, data loss risks (must fix)
2. **Warning** — logic concerns, missing error handling (should fix)
3. **Suggestion** — style, naming, minor improvements (nice to have)

End with a clear verdict: approve, request changes, or needs discussion.

## Constraints
- Flag real issues with high confidence. Do not nitpick style when the project has no style guide.
- If the mission includes a PR number, use gh CLI to leave review comments directly.
- Show the problematic code and explain why it's an issue, not just that it is one.
${FLEET_CONTEXT}`
  }
];

// ---- Types (imported from shared/ipc-api) ----

type SectorRow = StarbaseSectorRow;
type SupplyRoute = StarbaseSupplyRoute;
type RetentionStats = StarbaseRetentionStats;
type CleanupResult = StarbaseCleanupResult;

// ---- Sub-components ----

function SectionHeader({ title, count }: { title: string; count?: number }): React.JSX.Element {
  return (
    <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
      {title}
      {count !== undefined && <span className="ml-1 text-neutral-600">({count})</span>}
    </h3>
  );
}

// ---- Sectors Section ----

function SectorCard({
  sector,
  onRemove,
  onUpdate
}: {
  sector: SectorRow;
  onRemove: (id: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

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

          <div className="text-xs text-neutral-500 font-semibold mt-2 mb-1">Agent Config</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="text-neutral-500 block mb-1">Allowed Tools</label>
              <input
                type="text"
                value={sector.allowed_tools ?? ''}
                placeholder="e.g. Read,Edit,Bash"
                onChange={(e) => onUpdate(sector.id, { allowed_tools: e.target.value || null })}
                className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>
          </div>
          <div className="text-xs">
            <div className="flex items-center justify-between mb-1">
              <label className="text-neutral-500">System Prompt</label>
              <select
                value=""
                onChange={(e) => {
                  const tpl = AGENT_TEMPLATES.find((t) => t.id === e.target.value);
                  if (tpl) onUpdate(sector.id, { system_prompt: tpl.prompt });
                }}
                className="bg-neutral-900 text-neutral-400 text-xs rounded px-1.5 py-0.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
              >
                <option value="">Load template...</option>
                {AGENT_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={sector.system_prompt ?? ''}
              placeholder="Custom instructions for crew agents in this sector..."
              onChange={(e) => onUpdate(sector.id, { system_prompt: e.target.value || null })}
              rows={3}
              className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono resize-y"
            />
          </div>
          <div className="text-xs">
            <label className="text-neutral-500 block mb-1">MCP Config Path</label>
            <input
              type="text"
              value={sector.mcp_config ?? ''}
              placeholder="e.g. /path/to/mcp-config.json"
              onChange={(e) => onUpdate(sector.id, { mcp_config: e.target.value || null })}
              className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
            />
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
  );
}

function SectorsSection(): React.JSX.Element {
  const { sectors, setSectors } = useStarCommandStore();
  const [addPath, setAddPath] = useState('');
  const [addName, setAddName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.fleet.starbase.listSectors().then((s) => setSectors(s));
  }, [setSectors]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async (): Promise<void> => {
    if (!addPath.trim()) return;
    setError(null);
    try {
      await window.fleet.starbase.addSector({
        path: addPath.trim(),
        name: addName.trim() || undefined
      });
      setAddPath('');
      setAddName('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add sector');
    }
  };

  const handleRemove = async (sectorId: string): Promise<void> => {
    try {
      await window.fleet.starbase.removeSector(sectorId);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove sector');
    }
  };

  const handleUpdate = async (sectorId: string, fields: Record<string, unknown>): Promise<void> => {
    try {
      await window.fleet.starbase.updateSector(sectorId, fields);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update sector');
    }
  };

  return (
    <section>
      <SectionHeader title="Sectors" count={sectors.length} />

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded px-2 py-1 mb-2">{error}</div>
      )}

      <div className="space-y-2 mb-3">
        {sectors.map((s) => (
          <SectorCard
            key={s.id}
            sector={s}
            onRemove={(id) => {
              void handleRemove(id);
            }}
            onUpdate={(id, fields) => {
              void handleUpdate(id, fields);
            }}
          />
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
          <button
            onClick={() => {
              void window.fleet.showFolderPicker().then((path) => {
                if (path) setAddPath(path);
              });
            }}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 text-xs font-medium rounded transition-colors"
          >
            Browse
          </button>
          <input
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Name (optional)"
            className="w-32 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={() => {
              void handleAdd();
            }}
            disabled={!addPath.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- Supply Routes Section ----

function SupplyRoutesSection(): React.JSX.Element {
  const { sectors } = useStarCommandStore();
  const [routes, setRoutes] = useState<SupplyRoute[]>([]);
  const [graph, setGraph] = useState<Record<string, string[]>>({});
  const [upstream, setUpstream] = useState('');
  const [downstream, setDownstream] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sectorList = sectors;

  const refresh = useCallback(async () => {
    try {
      const [r, g] = await Promise.all([
        window.fleet.starbase.listSupplyRoutes(),
        window.fleet.starbase.getSupplyRouteGraph()
      ]);
      setRoutes(r);
      setGraph(g);
    } catch {
      // services may not be initialized
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAdd = async (): Promise<void> => {
    if (!upstream || !downstream) return;
    setError(null);
    try {
      await window.fleet.starbase.addSupplyRoute({
        upstreamSectorId: upstream,
        downstreamSectorId: downstream
      });
      setUpstream('');
      setDownstream('');
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add route');
    }
  };

  const handleRemove = async (routeId: number): Promise<void> => {
    try {
      await window.fleet.starbase.removeSupplyRoute(routeId);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove route');
    }
  };

  // Collect all sector IDs from graph for the visual
  const allNodes = new Set<string>();
  for (const [from, tos] of Object.entries(graph)) {
    allNodes.add(from);
    for (const to of tos) allNodes.add(to);
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
              onClick={() => {
                void handleRemove(route.id);
              }}
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
            onClick={() => {
              void handleAdd();
            }}
            disabled={!upstream || !downstream}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- Starbase Settings Section ----

const MODEL_OPTIONS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'];

const CONFIG_FIELDS: Array<{
  key: string;
  label: string;
  type: 'number' | 'text' | 'password' | 'select';
  options?: string[];
}> = [
  { key: 'anthropic_api_key', label: 'Anthropic API Key', type: 'password' },
  { key: 'admiral_model', label: 'Admiral Model', type: 'select', options: MODEL_OPTIONS },
  { key: 'crew_model_code', label: 'Crew Model (Code)', type: 'select', options: MODEL_OPTIONS },
  { key: 'crew_model_research', label: 'Crew Model (Research)', type: 'select', options: MODEL_OPTIONS },
  { key: 'crew_model_review', label: 'Crew Model (Review)', type: 'select', options: MODEL_OPTIONS },
  { key: 'crew_model_architect', label: 'Crew Model (Architect)', type: 'select', options: MODEL_OPTIONS },
  { key: 'crew_model_repair', label: 'Crew Model (Repair)', type: 'select', options: MODEL_OPTIONS },
  { key: 'first_officer_model', label: 'First Officer Model', type: 'select', options: MODEL_OPTIONS },
  { key: 'navigator_model', label: 'Navigator Model', type: 'select', options: MODEL_OPTIONS },
  { key: 'analyst_model', label: 'Analyst Model', type: 'select', options: MODEL_OPTIONS },
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
];

function toConfigString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function StarbaseSettingsSection(): React.JSX.Element {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    window.fleet.starbase
      .getConfig()
      .then(setConfig)
      .catch(() => {});
  }, []);

  const handleChange = async (key: string, value: unknown): Promise<void> => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setSaving(key);
    try {
      await window.fleet.starbase.setConfig(key, value);
    } catch {
      // revert on error
      const fresh = await window.fleet.starbase.getConfig();
      setConfig(fresh);
    }
    setSaving(null);
  };

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
                  value={toConfigString(config[field.key])}
                  onChange={(e) => {
                    void handleChange(field.key, e.target.value);
                  }}
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
                  defaultValue={toConfigString(config[field.key])}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== config[field.key]) void handleChange(field.key, v);
                  }}
                  placeholder="Not set"
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
                />
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  value={config[field.key] != null ? Number(config[field.key]) : ''}
                  onChange={(e) => {
                    void handleChange(field.key, e.target.value ? Number(e.target.value) : null);
                  }}
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
                />
              ) : (
                <input
                  type="text"
                  value={toConfigString(config[field.key])}
                  onChange={(e) => {
                    void handleChange(field.key, e.target.value);
                  }}
                  className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---- Database Section ----

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DatabaseSection(): React.JSX.Element {
  const [stats, setStats] = useState<RetentionStats | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);
  const [lastCleanup, setLastCleanup] = useState<CleanupResult | null>(null);

  const refresh = useCallback(() => {
    window.fleet.starbase
      .getRetentionStats()
      .then((s) => setStats(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCleanup = async (): Promise<void> => {
    setCleaning(true);
    try {
      const result = await window.fleet.starbase.retentionCleanup();
      setLastCleanup(result);
      refresh();
    } catch {
      // ignore
    }
    setCleaning(false);
  };

  const handleVacuum = async (): Promise<void> => {
    setVacuuming(true);
    try {
      await window.fleet.starbase.retentionVacuum();
      refresh();
    } catch {
      // ignore
    }
    setVacuuming(false);
  };

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
            onClick={() => {
              void handleCleanup();
            }}
            disabled={cleaning}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-neutral-200 text-xs rounded transition-colors"
          >
            {cleaning ? 'Cleaning...' : 'Clean Now'}
          </button>
          <button
            onClick={() => {
              void handleVacuum();
            }}
            disabled={vacuuming}
            className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 text-neutral-200 text-xs rounded transition-colors"
          >
            {vacuuming ? 'Compacting...' : 'Compact Database'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- Main Config Component ----

export function StarCommandConfig(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div className="text-sm text-neutral-300 font-semibold mb-2">Starbase Configuration</div>
      <SectorsSection />
      <SupplyRoutesSection />
      <StarbaseSettingsSection />
      <DatabaseSection />
    </div>
  );
}
