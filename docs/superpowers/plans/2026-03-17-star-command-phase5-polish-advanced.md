# Star Command Phase 5: Polish + Advanced — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Supply Routes, Quality Gates (verify/lint + Admiral review), Mission decomposition, the Config panel UI, the pixel art station visualizer, and database retention.

**Architecture:** SupplyRouteService manages the Sector dependency graph with cycle detection. CargoService tracks artifacts with verification tagging. Hull gets Gate 2 (verify/lint commands) and Gate 3 (Admiral PR review). Config panel is a React sub-tab. Visualizer extends the existing SpaceCanvas with station ring, pods, and Comms beams.

**Tech Stack:** React, existing visualizer canvas, existing StarbaseDB + services, gh CLI

**Spec:** `docs/superpowers/specs/2026-03-17-star-command-phase5-polish-advanced.md`

---

## File Structure

**New files:**
- `src/main/starbase/supply-route-service.ts` — Route CRUD with cycle detection
- `src/main/starbase/cargo-service.ts` — Cargo CRUD with verification tagging
- `src/main/starbase/retention-service.ts` — TTL-based cleanup + VACUUM
- `src/main/__tests__/supply-route-service.test.ts`
- `src/main/__tests__/cargo-service.test.ts`
- `src/main/__tests__/retention-service.test.ts`
- `src/renderer/src/components/StarCommandConfig.tsx` — Config panel UI
- `src/renderer/src/components/visualizer/station-ring.ts` — Station ring renderer
- `src/renderer/src/components/visualizer/crew-pods.ts` — Pod status sprites
- `src/renderer/src/components/visualizer/comms-beams.ts` — Comms beam animations

**Modified files:**
- `src/main/starbase/hull.ts` — Gate 2 (verify/lint) and Gate 3 (Admiral review)
- `src/main/starbase/admiral.ts` — PR review processing, decomposition prompt updates
- `src/main/starbase/admiral-system-prompt.ts` — Add decomposition instructions
- `src/main/starbase/admiral-tools.ts` — Add supply route and cargo tools
- `src/main/starbase/migrations.ts` — Add migration for indexes + new config keys
- `src/main/ipc-handlers.ts` — Supply route + cargo + retention IPC handlers
- `src/renderer/src/components/StarCommandTab.tsx` — Add Config sub-tab
- `src/renderer/src/components/visualizer/SpaceCanvas.tsx` — Integrate station ring layer

---

## Chunk 1: Supply Routes + Cargo

### Task 1: Write SupplyRouteService

**Files:**
- Create: `src/main/starbase/supply-route-service.ts`
- Create: `src/main/__tests__/supply-route-service.test.ts`

- [ ] **Step 1: Write failing tests**

Test: addRoute, cycle detection (reject A→B→A), listRoutes, getDownstream, getUpstream, getGraph, removeRoute.

- [ ] **Step 2: Write implementation**

DFS cycle detection before insertion. Adjacency list for graph representation.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add SupplyRouteService with cycle detection"
```

---

### Task 2: Write CargoService

**Files:**
- Create: `src/main/starbase/cargo-service.ts`
- Create: `src/main/__tests__/cargo-service.test.ts`

- [ ] **Step 1: Write failing tests**

Test: produceCargo, listCargo, getUndelivered with Supply Route traversal, unverified tagging for failed missions, cleanup by age.

- [ ] **Step 2: Write implementation**

`produceCargo` checks mission status for verified flag. `getUndelivered` traverses supply routes upstream. Respects `forward_failed_cargo` config.

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add CargoService with Supply Route integration"
```

---

## Chunk 2: Quality Gates

### Task 3: Add Gate 2 (verify/lint) to Hull

**Files:**
- Modify: `src/main/starbase/hull.ts`

- [ ] **Step 1: Add verify command execution**

After auto-commit, before push: if `sector.verify_command` is set, run it with 120s timeout. Store result in `missions.verify_result`. On failure: status "failed-verification", still push branch, skip PR, hail Admiral.

- [ ] **Step 2: Add lint command execution**

If `sector.lint_command` is set, run with 60s timeout. Warnings only — don't block PR. Add `lint-warnings` label if warnings found.

- [ ] **Step 3: Write tests for Gate 2 paths**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add Gate 2 verification and lint to Hull"
```

---

### Task 4: Add Gate 3 (Admiral review)

**Files:**
- Modify: `src/main/starbase/hull.ts`
- Modify: `src/main/starbase/admiral.ts`

- [ ] **Step 1: Hull sends pr_review_request Transmission after PR creation**

If `sector.review_mode === 'admiral-review'`, send Transmission with PR details.

- [ ] **Step 2: Admiral processes review**

Fetch diff via `gh pr diff`, check acceptance criteria, produce verdict (pass/request-changes/reject). Handle review failures gracefully (mark pending-review).

- [ ] **Step 3: Write tests for Gate 3 flow**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add Gate 3 Admiral PR review"
```

---

## Chunk 3: Mission Decomposition + Config Panel

### Task 5: Update Admiral system prompt for decomposition

**Files:**
- Modify: `src/main/starbase/admiral-system-prompt.ts`
- Modify: `src/main/starbase/admiral-tools.ts`

- [ ] **Step 1: Add decomposition instructions and examples to system prompt**
- [ ] **Step 2: Add supply route tools to Admiral tool definitions**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(starbase): add Mission decomposition and Supply Route tools to Admiral"
```

---

### Task 6: Build Config panel UI

**Files:**
- Create: `src/renderer/src/components/StarCommandConfig.tsx`
- Modify: `src/renderer/src/components/StarCommandTab.tsx`

- [ ] **Step 1: Create Config panel component**

Four sections: Sectors (list with CRUD forms), Supply Routes (graph display + add/remove), Starbase Settings (form fields for all config keys), Database (size, row counts, compact button, retention settings).

- [ ] **Step 2: Add Config sub-tab to StarCommandTab**

Toggle between Chat and Config views via header buttons.

- [ ] **Step 3: Wire IPC for supply routes, cargo, retention**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add Config panel UI with Sector/Route/Settings management"
```

---

## Chunk 4: Visualizer Integration

### Task 7: Add station ring, pods, and Comms beams to visualizer

**Files:**
- Create: `src/renderer/src/components/visualizer/station-ring.ts`
- Create: `src/renderer/src/components/visualizer/crew-pods.ts`
- Create: `src/renderer/src/components/visualizer/comms-beams.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create station ring renderer**

Circular structure divided into Sector sections. Labels, lit/dim based on activity. CSS sprite animation for rotation.

- [ ] **Step 2: Create crew pod renderer**

Pod sprites attached to ring sections. Status-based animations: teal (active), amber (hailing), red (error), green (complete), sparks (lost). One-shot canvas particles for transient effects.

- [ ] **Step 3: Create Comms beam renderer**

Glowing orbs traveling along beam lines between pods and central hub. Cross-Sector arcs for Supply Routes.

- [ ] **Step 4: Integrate into SpaceCanvas**

Add station ring, pods, beams as new canvas layers. Drive state from `star-command-store`. Implement visibility-aware throttling and performance budget.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(starbase): add station ring, crew pods, and Comms beams to visualizer"
```

---

## Chunk 5: Retention + Schema + Final Integration

### Task 8: Write RetentionService and add schema migration

**Files:**
- Create: `src/main/starbase/retention-service.ts`
- Create: `src/main/__tests__/retention-service.test.ts`
- Modify: `src/main/starbase/migrations.ts`

- [ ] **Step 1: Add migration for indexes and retention config**

New migration: add indexes on `cargo(sector_id)`, `comms(to_crew, read)`, `missions(status, sector_id)`. Seed retention config defaults.

- [ ] **Step 2: Write RetentionService**

`cleanup()` deletes records older than TTLs. `vacuum()` runs VACUUM. `getStats()` returns table sizes.

- [ ] **Step 3: Write tests**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(starbase): add RetentionService and schema indexes"
```

---

### Task 9: Final integration and verification

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Wire SupplyRouteService, CargoService, RetentionService into main process**
- [ ] **Step 2: Register IPC handlers for all new services**
- [ ] **Step 3: Run typecheck**

```bash
cd /Users/khangnguyen/Development/fleet && npm run typecheck
```

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/khangnguyen/Development/fleet && npm test
```

- [ ] **Step 5: Run lint**

```bash
cd /Users/khangnguyen/Development/fleet && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(starbase): wire Phase 5 services and complete Star Command integration"
```
