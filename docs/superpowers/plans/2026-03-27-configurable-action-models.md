# Configurable Action Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure which model backs each image action (e.g. swap the background-removal model) via settings and CLI.

**Architecture:** Add `ImageActionSettings` type and optional `actions` map to `ImageProviderSettings`. `FalAiProvider` stores its settings and applies model overrides in `getActions()`. CLI gains `--action`/`--model` flags on `fleet images config`.

**Tech Stack:** TypeScript, Electron IPC, node-pty socket API

---

### Task 1: Add `ImageActionSettings` type to shared types

**Files:**
- Modify: `src/shared/types.ts:178-184`

- [ ] **Step 1: Add the type and extend `ImageProviderSettings`**

In `src/shared/types.ts`, add `ImageActionSettings` before `ImageProviderSettings` and add the `actions` field:

```ts
export type ImageActionSettings = {
  model?: string;
};

export type ImageProviderSettings = {
  apiKey: string;
  defaultModel: string;
  defaultResolution: string;
  defaultOutputFormat: string;
  defaultAspectRatio: string;
  actions?: Record<string, ImageActionSettings>;
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — the new field is optional so no existing code breaks.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(images): add ImageActionSettings type for configurable action models"
```

---

### Task 2: Store settings in `FalAiProvider` and apply model overrides in `getActions()`

**Files:**
- Modify: `src/main/image-providers/fal-ai.ts:9-111`

- [ ] **Step 1: Store settings on configure and use in getActions**

In `src/main/image-providers/fal-ai.ts`, add a `storedSettings` field and update `configure()` to save settings. Then update `getActions()` to check for model overrides:

```ts
export class FalAiProvider implements ImageProvider {
  id = 'fal-ai';
  name = 'fal.ai';
  private currentModel = 'fal-ai/nano-banana-2';
  private storedSettings: Record<string, unknown> = {};

  configure(settings: Record<string, unknown>): void {
    this.storedSettings = settings;
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : '';
    if (apiKey) {
      fal.config({ credentials: apiKey });
    }
  }
```

Then update `getActions()` to read the override:

```ts
  getActions(): ImageActionConfig[] {
    const actionSettings =
      this.storedSettings.actions != null && typeof this.storedSettings.actions === 'object'
        ? (this.storedSettings.actions as Record<string, Record<string, unknown>>)
        : {};
    const rbModel =
      typeof actionSettings['remove-background']?.model === 'string'
        ? actionSettings['remove-background'].model
        : null;
    const rbEndpoint = rbModel
      ? `https://fal.run/${rbModel}`
      : 'https://fal.run/fal-ai/bria/background/remove';

    return [
      {
        id: 'fal-ai:remove-background',
        actionType: 'remove-background',
        provider: 'fal-ai',
        name: 'Remove Background',
        description: rbModel
          ? `Remove the background from an image (${rbModel})`
          : 'Remove the background from an image (BRIA RMBG 2.0)',
        endpoint: rbEndpoint,
        inputMapping: (url: string) => ({ image_url: url, sync_mode: true }),
        outputMapping: (response: unknown) => {
          const data = response != null && typeof response === 'object' ? response : {};
          const img =
            'image' in data && data.image != null && typeof data.image === 'object'
              ? data.image
              : {};
          return {
            url: 'url' in img && typeof img.url === 'string' ? img.url : '',
            width: 'width' in img && typeof img.width === 'number' ? img.width : 0,
            height: 'height' in img && typeof img.height === 'number' ? img.height : 0
          };
        },
        outputFormat: 'png'
      }
    ];
  }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/image-providers/fal-ai.ts
git commit -m "feat(images): apply action model overrides from provider settings"
```

---

### Task 3: Handle `--action` and `--model` flags in CLI config command

**Files:**
- Modify: `src/main/fleet-cli.ts:1246-1288` (images config section)

- [ ] **Step 1: Add `--action` and `--model` to the set-flag detection**

In `src/main/fleet-cli.ts`, find the `images config` handler (around line 1246). Update the `hasSetFlags` check to include `'action'` and `'model'`:

```ts
    const hasSetFlags = Object.keys(configArgs).some((k) =>
      [
        'api-key',
        'default-model',
        'default-resolution',
        'default-output-format',
        'default-aspect-ratio',
        'provider',
        'action',
        'model'
      ].includes(k)
    );
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "feat(images): recognize --action and --model flags in CLI config command"
```

---

### Task 4: Handle action settings in `image.config.set` socket handler

**Files:**
- Modify: `src/main/socket-server.ts:1186-1205`

- [ ] **Step 1: Add action settings handling to `image.config.set`**

In `src/main/socket-server.ts`, in the `image.config.set` case (around line 1186), after the existing `providerUpdate` logic and before the `if (Object.keys(providerUpdate).length > 0)` check, add handling for `--action` + `--model`:

```ts
      case 'image.config.set': {
        if (!this.imageService) throw new CodedError('Image service not available', 'UNAVAILABLE');
        const providerId = typeof args.provider === 'string' ? args.provider : undefined;
        const providerKey = providerId ?? this.imageService.getSettings().defaultProvider;
        const providerUpdate: Partial<ImageProviderSettings> = {};
        if (typeof args['api-key'] === 'string') providerUpdate.apiKey = args['api-key'];
        if (typeof args['default-model'] === 'string')
          providerUpdate.defaultModel = args['default-model'];
        if (typeof args['default-resolution'] === 'string')
          providerUpdate.defaultResolution = args['default-resolution'];
        if (typeof args['default-output-format'] === 'string')
          providerUpdate.defaultOutputFormat = args['default-output-format'];
        if (typeof args['default-aspect-ratio'] === 'string')
          providerUpdate.defaultAspectRatio = args['default-aspect-ratio'];

        // Action-level model override: --action remove-background --model fal-ai/birefnet/v2
        if (typeof args.action === 'string' && typeof args.model === 'string') {
          const currentSettings = this.imageService.getSettings();
          const currentProvider = currentSettings.providers[providerKey];
          const existingActions = currentProvider?.actions ?? {};
          providerUpdate.actions = {
            ...existingActions,
            [args.action]: { model: args.model }
          };
        }

        if (Object.keys(providerUpdate).length > 0) {
          this.imageService.updateSettings({ providers: { [providerKey]: providerUpdate } });
        }
        this.emit('state-change', 'image:changed', {});
        return { updated: true };
      }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/socket-server.ts
git commit -m "feat(images): handle action model override in image.config.set"
```

---

### Task 5: Display action settings in `image.config.get` output and update help text

**Files:**
- Modify: `src/main/fleet-cli.ts:1266-1282` (config display section)
- Modify: `src/main/fleet-cli.ts` (help text section around lines 1130-1150)

- [ ] **Step 1: Update the config display to show action overrides**

In `src/main/fleet-cli.ts`, update the config display loop (around line 1271) to render `actions` nested under each provider. Replace the provider rendering block:

```ts
        if (isRecord(providers)) {
          for (const [name, val] of Object.entries(providers)) {
            lines.push(`${name}:`);
            if (isRecord(val)) {
              for (const [k, v] of Object.entries(val)) {
                if (k === 'actions' && isRecord(v)) {
                  lines.push(`  actions:`);
                  for (const [actionName, actionVal] of Object.entries(v)) {
                    lines.push(`    ${actionName}:`);
                    if (isRecord(actionVal)) {
                      for (const [ak, av] of Object.entries(actionVal)) {
                        lines.push(`      ${ak}: ${toStr(av)}`);
                      }
                    }
                  }
                } else {
                  lines.push(`  ${k}: ${toStr(v)}`);
                }
              }
            }
          }
        }
```

- [ ] **Step 2: Update the help text**

Find the help text section (around line 1130) and add the new flags. After the `fleet images config --api-key <key>` line:

```
  fleet images config --action <type> --model <id>  Set model for an action
```

And in the examples section (around line 1148), add:

```
  fleet images config --action remove-background --model fal-ai/birefnet/v2
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "feat(images): display action settings in config output and update help text"
```

---

### Task 6: Display action config in `image.config.get` socket handler

**Files:**
- Modify: `src/main/socket-server.ts:1173-1184`

- [ ] **Step 1: Include actions in the redacted config output**

In `src/main/socket-server.ts`, the `image.config.get` handler (around line 1173) already returns the full settings object with redacted API keys. Since `actions` is a simple data field on `ImageProviderSettings`, it will be included automatically in the spread. No code change needed — verify by reading the handler.

If the spread already copies all fields (it does: `{ ...val, apiKey: redacted }`), then actions will flow through. Confirm by running:

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Commit (skip if no changes needed)**

Only commit if you made changes. Otherwise mark this task complete.

---

### Task 7: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS
