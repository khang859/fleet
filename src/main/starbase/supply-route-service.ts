import type Database from 'better-sqlite3'

export class CyclicDependencyError extends Error {
  constructor(cyclePath: string[]) {
    super(`Cyclic dependency detected: ${cyclePath.join(' -> ')}`)
    this.name = 'CyclicDependencyError'
  }
}

type SupplyRouteRow = {
  id: number
  upstream_sector_id: string
  downstream_sector_id: string
  relationship: string | null
  created_at: string
}

type AddRouteOpts = {
  upstreamSectorId: string
  downstreamSectorId: string
  relationship?: string
}

type ListRoutesOpts = {
  sectorId?: string
}

export class SupplyRouteService {
  constructor(private db: Database.Database) {}

  addRoute(opts: AddRouteOpts): SupplyRouteRow {
    const { upstreamSectorId, downstreamSectorId, relationship } = opts

    // Self-reference is a trivial cycle
    if (upstreamSectorId === downstreamSectorId) {
      throw new CyclicDependencyError([upstreamSectorId, downstreamSectorId])
    }

    // Cycle detection: check if adding upstream -> downstream creates a cycle
    // A cycle exists if there is already a path from downstream back to upstream
    this.detectCycle(upstreamSectorId, downstreamSectorId)

    const result = this.db
      .prepare(
        `INSERT INTO supply_routes (upstream_sector_id, downstream_sector_id, relationship)
         VALUES (?, ?, ?)`
      )
      .run(upstreamSectorId, downstreamSectorId, relationship ?? null)

    return this.db
      .prepare<[number | bigint], SupplyRouteRow>('SELECT * FROM supply_routes WHERE id = ?')
      .get(result.lastInsertRowid)!
  }

  removeRoute(routeId: number): void {
    const result = this.db.prepare('DELETE FROM supply_routes WHERE id = ?').run(routeId)
    if (result.changes === 0) {
      throw new Error(`Route not found: ${routeId}`)
    }
  }

  listRoutes(opts?: ListRoutesOpts): SupplyRouteRow[] {
    if (opts?.sectorId) {
      return this.db
        .prepare<[string, string], SupplyRouteRow>(
          `SELECT * FROM supply_routes
           WHERE upstream_sector_id = ? OR downstream_sector_id = ?
           ORDER BY id`
        )
        .all(opts.sectorId, opts.sectorId)
    }
    return this.db.prepare<[], SupplyRouteRow>('SELECT * FROM supply_routes ORDER BY id').all()
  }

  getDownstream(sectorId: string): SupplyRouteRow[] {
    return this.db
      .prepare<[string], SupplyRouteRow>('SELECT * FROM supply_routes WHERE upstream_sector_id = ? ORDER BY id')
      .all(sectorId)
  }

  getUpstream(sectorId: string): SupplyRouteRow[] {
    return this.db
      .prepare<[string], SupplyRouteRow>('SELECT * FROM supply_routes WHERE downstream_sector_id = ? ORDER BY id')
      .all(sectorId)
  }

  getGraph(): Record<string, string[]> {
    const rows = this.db
      .prepare<[], { upstream_sector_id: string; downstream_sector_id: string }>('SELECT upstream_sector_id, downstream_sector_id FROM supply_routes ORDER BY id')
      .all()

    const graph: Record<string, string[]> = {}
    for (const row of rows) {
      if (!graph[row.upstream_sector_id]) {
        graph[row.upstream_sector_id] = []
      }
      graph[row.upstream_sector_id].push(row.downstream_sector_id)
    }
    return graph
  }

  /**
   * DFS cycle detection. Before adding edge upstream -> downstream,
   * check if there's already a path from downstream to upstream in the existing graph.
   * If so, adding this edge would create a cycle.
   */
  private detectCycle(upstreamSectorId: string, downstreamSectorId: string): void {
    // Build adjacency list from existing routes
    const graph = this.getGraph()

    // DFS from downstreamSectorId to see if we can reach upstreamSectorId
    const visited = new Set<string>()
    const path: string[] = [downstreamSectorId]

    const dfs = (node: string): string[] | null => {
      if (node === upstreamSectorId) {
        return [...path]
      }
      if (visited.has(node)) {
        return null
      }
      visited.add(node)

      const neighbors = graph[node]
      if (!neighbors) return null

      for (const neighbor of neighbors) {
        path.push(neighbor)
        const cyclePath = dfs(neighbor)
        if (cyclePath) return cyclePath
        path.pop()
      }

      return null
    }

    const cyclePath = dfs(downstreamSectorId)
    if (cyclePath) {
      // Prepend the upstream to show the full cycle: upstream -> downstream -> ... -> upstream
      throw new CyclicDependencyError([upstreamSectorId, ...cyclePath])
    }
  }
}
