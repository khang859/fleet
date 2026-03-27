# Per-Mission-Type Model Configuration

## Problem

Crew model selection is currently per-sector (a free-text field on the sector config) with a hardcoded fallback to `claude-sonnet-4-6`. The First Officer, Navigator, and Analyst models exist in `starbase_config` but are not exposed in the UI. Users cannot control which models their crews use without editing each sector individually, and there is no way to set different models for different mission types (code, research, review, architect, repair).

## Design

### Global model config keys

Add per-mission-type crew model keys to `starbase_config`, all defaulting to `claude-haiku-4-5`:

| Key                    | Default            | Used by                 |
| ---------------------- | ------------------ | ----------------------- |
| `crew_model_code`      | `claude-haiku-4-5` | Code mission crews      |
| `crew_model_research`  | `claude-haiku-4-5` | Research mission crews  |
| `crew_model_review`    | `claude-haiku-4-5` | Review mission crews    |
| `crew_model_architect` | `claude-haiku-4-5` | Architect mission crews |
| `crew_model_repair`    | `claude-haiku-4-5` | Repair mission crews    |

Existing keys to surface in the UI (already in DB):

| Key                   | Default            | Used by                        |
| --------------------- | ------------------ | ------------------------------ |
| `first_officer_model` | `claude-haiku-4-5` | First Officer (PR review)      |
| `navigator_model`     | `claude-haiku-4-5` | Navigator (protocol execution) |
| `analyst_model`       | _(unset)_          | Analyst (verdict extraction)   |
| `admiral_model`       | _(already in UI)_  | Admiral                        |

### Model resolution

When deploying a crew, the model is resolved purely from the global config:

```
configService.getString(`crew_model_${missionType}`)
```

No sector-level override. No hardcoded fallback in Hull — the caller always provides the model.

### Files to change

**`src/main/starbase/migrations.ts`**

- New migration inserting defaults for 5 `crew_model_*` keys.
- Add all 5 keys to `CONFIG_DEFAULTS`.

**`src/main/starbase/hull.ts`**

- Change `const model = this.opts.model || 'claude-sonnet-4-6'` to use `this.opts.model` directly (required field, no fallback).
- Update `HullOpts.model` from optional to required.

**`src/main/starbase/crew-service.ts`**

- Read model from `configService.getString(`crew*model*${missionType}`)`.
- Pass it to Hull instead of `sector.model`.

**`src/renderer/src/components/StarCommandConfig.tsx`**

- Add `crew_model_code`, `crew_model_research`, `crew_model_review`, `crew_model_architect`, `crew_model_repair`, `first_officer_model`, `navigator_model`, `analyst_model` to `CONFIG_FIELDS`.
- Group under a "Models" subsection label in the Starbase Settings panel.
- Remove the "Model" text input from the per-sector config card.

**`src/main/starbase/workspace-templates.ts`**

- Remove references to sector-level model in help text/docs.

**`src/main/fleet-cli.ts`**

- Remove model from `sectors show` output.

### What stays

- The `model` column on the `sectors` table stays in the DB (no destructive migration). It is simply no longer read or written.
- The `HullOpts.model` field becomes required — TypeScript enforces that callers always provide a model.

### Data flow

```
deployCrew(missionType)
  → configService.getString(`crew_model_${missionType}`)
  → new Hull({ model, ... })
  → claude --model <model>
```
