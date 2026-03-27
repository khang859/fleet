# Configurable Action Models Design

Date: 2026-03-27

## Summary

Make image action models configurable per-provider so users can swap which model backs an action (e.g. use a different background removal model). Extends the existing image actions system (2026-03-26) with per-action settings in provider config.

## Decisions

- **Action overrides in provider settings** — each provider's settings gains an `actions` map keyed by `actionType`. This keeps overrides scoped to the provider that owns the action.
- **Model ID as the override** — a short fal.ai model ID (e.g. `fal-ai/birefnet/v2`) that gets expanded to the full endpoint URL. The provider knows how to map model → endpoint.
- **Hardcoded defaults remain** — if no override is set, the built-in default model is used. Zero-config still works.
- **CLI configuration** — `fleet images config --action <type> --model <model>` writes the override.

## Settings Schema Changes

```ts
// src/shared/types.ts

type ImageActionSettings = {
  model?: string; // fal.ai model ID, e.g. 'fal-ai/birefnet/v2'
};

type ImageProviderSettings = {
  apiKey: string;
  defaultModel: string;
  defaultResolution: string;
  defaultOutputFormat: string;
  defaultAspectRatio: string;
  actions?: Record<string, ImageActionSettings>;
};
```

Example `~/.fleet/images/settings.json`:

```json
{
  "defaultProvider": "fal-ai",
  "providers": {
    "fal-ai": {
      "apiKey": "...",
      "defaultModel": "fal-ai/nano-banana-2",
      "actions": {
        "remove-background": {
          "model": "fal-ai/birefnet/v2"
        }
      }
    }
  }
}
```

## Provider Changes

`FalAiProvider`:

1. Store settings passed to `configure()` on the instance (`this.settings`).
2. In `getActions()`, check `this.settings?.actions?.[actionType]?.model` for an override.
3. If override exists, use it to build the endpoint URL (`https://fal.run/${model}`). Otherwise use the hardcoded default.
4. The `inputMapping` and `outputMapping` stay the same — models that share an action type share the same API shape.

## CLI Changes

Extend `fleet images config` to accept action-level flags:

```
fleet images config --action remove-background --model fal-ai/birefnet/v2
```

- `--action` specifies which action type to configure.
- `--model` specifies the model ID override.
- Both flags must be provided together.
- Writes to `settings.providers[defaultProvider].actions[actionType].model`.

## Files to Modify

- `src/shared/types.ts` — add `ImageActionSettings`, add `actions?` to `ImageProviderSettings`
- `src/main/image-providers/fal-ai.ts` — store settings, apply model overrides in `getActions()`
- `src/main/fleet-cli.ts` — add `--action` and `--model` flags to `images config` command
- `src/main/socket-server.ts` — pass new config fields through to `imageService.updateSettings()`
