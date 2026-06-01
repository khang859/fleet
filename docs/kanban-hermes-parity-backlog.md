# Kanban — Hermes Parity Backlog

Remaining `reference/hermes-agent` kanban capabilities not yet ported to Fleet.

**Status as of 2026-05-31.** Done so far: core task lifecycle, dependencies/links, comments, attachments, dispatcher + concurrency, scheduling (cron/interval/once), multi-board, decompose/specify request plumbing, in-app notifications (Phase 7: OS + badge), and the Kanban Swarm topology helper.

Sizes are rough (small / medium / large) based on a source comparison of `reference/hermes-agent/hermes_cli/` against `src/main/kanban/`, `src/main/fleet-cli.ts`, `src/main/socket-server.ts`, and `src/renderer/src/components/kanban/`.

---

## Scope notes (before picking from this list)

- **External notifications** (hermes `notify-subscribe`/`-unsubscribe`/`-list` → Slack/Discord/email gateway) are intentionally **out of scope** for now — Fleet is a desktop app and Phase 7 already delivers OS + badge notifications for the attention-worthy events.
- **Live `watch`** (CLI event stream) is **lower value** — the dashboard already streams `task_events` live. A CLI `watch` would only matter for headless/terminal use.
- A few hermes flags (`--tenant` scoping, `model_override`, per-task `--max-runtime`, `--idempotency-key`) are partially represented in Fleet's schema but not wired end-to-end; grouped under "Operational config" below.

---

## High-leverage (observability & recovery)

| Feature | Description | Size |
|---|---|---|
| **Worker logs & run history** | Surface per-attempt run history (run id, profile, outcome, elapsed, summary, metadata) and stream a worker's stdout/stderr from `kanban/logs/<task-id>`. CLI: `fleet kanban runs <id>`, `fleet kanban log <id>`. Dashboard: a "Runs" + "Logs" section in the task drawer. The biggest agent-debugging blind spot today. | medium |
| **Board diagnostics** | Rule engine for board health signals — crash loops, stuck-blocked tasks, spawn failures, phantom IDs — each with an actionable recovery hint. CLI: `fleet kanban diagnostics`; dashboard: a health panel. | large |
| **Reclaim a stuck claim** | `fleet kanban reclaim <id>` — release a running task whose worker died, returning it to `ready`. Recovery path; Fleet currently only reclaims stale claims internally in the dispatcher. | small |
| **Promote with dependency validation** | `fleet kanban promote <id> [--force] [--dry-run]` — manually move `todo`→`ready` with a check that all parents are settled (or `--force` to override). `--dry-run` reports what would happen without mutating. | small |
| **Edit / backfill (recovery)** | `fleet kanban edit <id> --result <text> [--summary ...] [--metadata ...]` — backfill result/summary/metadata on an already-completed task. | small |

## Operational

| Feature | Description | Size |
|---|---|---|
| **GC / retention** | `fleet kanban gc --event-retention-days <N> --log-retention-days <N>` — purge archived task workspaces, old events, and worker logs by retention window (manual + optionally scheduled). | medium |
| **Claim + workspace resolution** | `fleet kanban claim <id>` — atomically claim a ready task and print the resolved workspace path + claim TTL (for manual/headless workers). | medium |
| **Task context verb** | `fleet kanban context <id>` — print the merged worker-visible context (body + parent results + comments). Logic exists in the store; not exposed as a CLI verb. | small |
| **Assignee roster** | `fleet kanban assignees` — list configured profiles + per-profile task counts. | small |
| **Bulk operations** | `fleet kanban block --ids t1 t2 …` / `promote --ids …` — status changes across multiple tasks with a shared reason. | small |
| **Batch specify** | `fleet kanban specify --all [--tenant]` — batch triage→todo promotion across the triage column. | small |
| **Board run-time override** | `fleet kanban --board <slug> …` — override the active board for a single invocation. | small |
| **Per-board default workdir** | `fleet kanban boards set-default-workdir <slug> <path>` — board-level workspace default. | small |
| **`dir:` workspace kind** | Support `--workspace dir:<path>` for arbitrary directory workspaces (Fleet currently supports scratch + worktree). | small |

## Operational config (schema present, not wired end-to-end)

| Feature | Description | Size |
|---|---|---|
| **Tenant isolation** | Full `--tenant` scoping on create/list/dispatch (the `task.tenant` field exists but isn't enforced in dispatch/operations). | medium |
| **Dispatcher configuration** | Expose `failureLimit`, `dispatch_interval`, `orchestrator_profile`, `default_assignee` as configurable settings (currently effectively hardcoded). | medium |
| **Decompose orchestration depth** | Full decompose fan-out: parent indices, parallel routing, auto-promote, profile-roster matching, specify fallback. Fleet has the request plumbing; the orchestration logic is minimal. | medium |
| **Per-task model override** | `task.model_override` + `--model` on create. | small |
| **Per-task max runtime** | `--max-runtime <30s\|5m\|2h>` per-task timeout override (Fleet has a global default only). | small |
| **Idempotency key** | `--idempotency-key` dedup on create/swarm (Fleet's `CreateTaskInput` carries the field but create doesn't dedup on it). | small |
| **JSON output** | `--json` machine-readable output across CLI verbs (the socket server returns JSON; the CLI formatting layer is inconsistent). | small |

---

## Suggested ordering

1. **Worker logs & run history** — unblocks debugging every other feature and the agents themselves.
2. **Board diagnostics** — builds naturally on runs/logs data.
3. **Recovery ops** (reclaim, promote-with-validation, edit) — small, complementary, ship together.
4. **GC / retention** — once there's enough history accumulating to be worth pruning.

Everything below that is incremental polish; pull individual rows into a spec as needed.
