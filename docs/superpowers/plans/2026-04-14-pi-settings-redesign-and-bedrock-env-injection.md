# Pi Settings Redesign + Bedrock Env-Var Injection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the Pi Agent settings page into a welcome strip + unified Providers list + trimmed Defaults + Advanced accordion, and add a first-class Bedrock panel that stores AWS credentials via Electron `safeStorage` and injects them into every Pi tab Fleet spawns.

**Architecture:** A new `PiEnvInjectionManager` (main process) stores Bedrock config in a dedicated `electron-store` file. Secrets are encrypted with `safeStorage`. When the renderer asks for a Pi launch config, the handler calls `getInjectedEnv()` which decrypts on demand and passes the resolved env map to `PiAgentManager.buildLaunchCommand`, which inlines them with POSIX shell-quoting before the pi binary. Renderer UI replaces the existing `PiSection` layout with four stacked regions; `PiBedrockPanel` is a new component; legacy `providers.bedrock` custom entries get a one-time inline migration prompt.

**Tech Stack:** Electron `safeStorage`, `electron-store`, Zod, React, Tailwind, Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-04-14-pi-settings-redesign-and-bedrock-env-injection.md`.

**Verification commands used throughout:**

- Tests: `npm test -- <file>` (Vitest)
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Dev run: `npm run dev`

**Renderer testing note:** This repo has no `@testing-library/react` or `jsdom` in `package.json`. Renderer components are verified via `npm run typecheck`, `npm run lint`, and a manual `npm run dev` smoke at the end. Pure functions extracted from renderer code (ordering, status derivation) are unit-tested under `src/renderer/src/components/settings/pi/__tests__/`.

---

## File Structure

### New files

- `src/shared/pi-env-injection-types.ts` — Zod schemas + types for `PiBedrockInjection`, `RedactedBedrock`, credential modes.
- `src/main/pi-env-injection-manager.ts` — storage manager: write/read/redact/clear/`getInjectedEnv`.
- `src/main/__tests__/pi-env-injection-manager.test.ts`.
- `src/main/__tests__/pi-agent-manager.test.ts` — new, covers `buildLaunchCommand` with env overrides + `posixShellQuote`.
- `src/renderer/src/components/settings/pi/PiProvidersList.tsx` — unified list.
- `src/renderer/src/components/settings/pi/PiProviderRow.tsx` — row + expansion dispatch.
- `src/renderer/src/components/settings/pi/PiBedrockPanel.tsx` — Bedrock-specific form.
- `src/renderer/src/components/settings/pi/PiWelcomeStrip.tsx` — zero-state onboarding.
- `src/renderer/src/components/settings/pi/PiAdvancedAccordion.tsx` — collapsed advanced region.
- `src/renderer/src/components/settings/pi/lib/provider-ordering.ts` — pure function for row ordering (unit-testable).
- `src/renderer/src/components/settings/pi/__tests__/provider-ordering.test.ts`.

### Modified files

- `src/main/pi-agent-manager.ts` — `buildLaunchCommand(envOverrides)` + `posixShellQuote` helper.
- `src/main/ipc-handlers.ts` — wire `PI_ENV_*` handlers, pass injected env into `PI_LAUNCH_CONFIG`.
- `src/main/index.ts` — instantiate `PiEnvInjectionManager`, pass to handlers.
- `src/preload/index.ts` — expose `window.fleet.piEnv.*`.
- `src/shared/ipc-channels.ts` — new `PI_ENV_*` constants.
- `src/shared/pi-presets.ts` — remove `bedrock` preset from `PI_PRESETS`; add `managedEnv: true` flag on the Bedrock entry in `PI_BUILT_IN_PROVIDERS`.
- `src/renderer/src/components/settings/pi/PiSection.tsx` — new top-level layout.
- `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx` — drop theme + model cycling fields (moved to Advanced).
- `src/renderer/src/components/settings/pi/PiPresetPicker.tsx` — hide the Bedrock preset card.

### Unchanged

- `src/main/pi-config-manager.ts`, `src/main/pi-auth-inspector.ts`, `src/shared/pi-config-types.ts`.
- `PiProviderForm`, `PiApiKeyInput`, `PiModelsEditor` — reused from the custom-provider path.
- `PiBuiltInProvidersList` — deleted (its functionality absorbed by the unified list).

---

## Task 1: Zod schemas for Bedrock env injection

**Files:**

- Create: `src/shared/pi-env-injection-types.ts`
- Create: `src/main/__tests__/pi-env-injection-manager.test.ts` (will be extended in later tasks; Task 1 only adds schema round-trip tests)

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/pi-env-injection-manager.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PiBedrockInjectionSchema,
  PiEnvInjectionSchema
} from '../../shared/pi-env-injection-types';

describe('PiBedrockInjectionSchema', () => {
  it('defaults mode to "chain"', () => {
    const parsed = PiBedrockInjectionSchema.parse({});
    expect(parsed.mode).toBe('chain');
  });

  it('accepts all three modes', () => {
    for (const mode of ['profile', 'keys', 'chain'] as const) {
      expect(PiBedrockInjectionSchema.parse({ mode }).mode).toBe(mode);
    }
  });

  it('preserves unknown sibling keys via passthrough', () => {
    const parsed = PiEnvInjectionSchema.parse({
      bedrock: { mode: 'profile', profile: 'dev' },
      futureProvider: { apiKey: 'x' }
    });
    expect(parsed).toMatchObject({ futureProvider: { apiKey: 'x' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- pi-env-injection-manager`
Expected: FAIL — module `'../../shared/pi-env-injection-types'` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/pi-env-injection-types.ts`:

```ts
import { z } from 'zod';

export const PiBedrockCredentialModeSchema = z.enum(['profile', 'keys', 'chain']);
export type PiBedrockCredentialMode = z.infer<typeof PiBedrockCredentialModeSchema>;

export const PiBedrockInjectionSchema = z.object({
  mode: PiBedrockCredentialModeSchema.default('chain'),
  region: z.string().optional(),
  profile: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKeyEnc: z.string().optional(),
  sessionTokenEnc: z.string().optional()
});
export type PiBedrockInjection = z.infer<typeof PiBedrockInjectionSchema>;

export const PiEnvInjectionSchema = z
  .object({
    bedrock: PiBedrockInjectionSchema.optional()
  })
  .passthrough();
export type PiEnvInjection = z.infer<typeof PiEnvInjectionSchema>;

/** Safe-for-IPC view: secrets collapsed to a presence flag. */
export type RedactedBedrock = {
  mode: PiBedrockCredentialMode;
  region?: string;
  profile?: string;
  accessKeyId?: string;
  secretAccessKeyPresent: boolean;
  sessionTokenPresent: boolean;
};

/**
 * Patch accepted by PiEnvInjectionManager.writeBedrock and by the preload.
 * Shared so the renderer can type preload calls without reaching into main/.
 * Secret fields are plaintext at the boundary and encrypted on arrival.
 */
export type BedrockWritePatch = {
  mode?: PiBedrockCredentialMode;
  region?: string;
  profile?: string;
  accessKeyId?: string;
  /** Plaintext; encrypted on write. Empty string clears the stored secret. */
  secretAccessKey?: string;
  sessionToken?: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- pi-env-injection-manager`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/pi-env-injection-types.ts src/main/__tests__/pi-env-injection-manager.test.ts
git commit -m "feat(pi): zod schema for Bedrock env-injection config"
```

---

## Task 2: `posixShellQuote` helper + `buildLaunchCommand` envOverrides param

**Files:**

- Modify: `src/main/pi-agent-manager.ts` (lines 92-107, `buildLaunchCommand`)
- Create: `src/main/__tests__/pi-agent-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/__tests__/pi-agent-manager.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PiAgentManager, posixShellQuote } from '../pi-agent-manager';

describe('posixShellQuote', () => {
  it('single-quotes simple values', () => {
    expect(posixShellQuote('hello')).toBe(`'hello'`);
  });

  it("escapes single quotes via the standard '\\'' sequence", () => {
    expect(posixShellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('passes through values with spaces, $, backticks without interpretation', () => {
    expect(posixShellQuote('$HOME `whoami`')).toBe(`'$HOME \`whoami\`'`);
  });

  it('quotes an empty string to preserve it', () => {
    expect(posixShellQuote('')).toBe(`''`);
  });
});

describe('PiAgentManager.buildLaunchCommand', () => {
  const mgr = new PiAgentManager();

  it('produces an empty envOverrides path identical to the 3-arg form', () => {
    // Compare shape: no env assignments before FLEET_BRIDGE_PORT.
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', {});
    expect(
      cmd.startsWith('FLEET_BRIDGE_PORT=8123 FLEET_BRIDGE_TOKEN=tok FLEET_PANE_ID=pane-1 ')
    ).toBe(true);
  });

  it('prepends envOverrides with POSIX shell-quoting before FLEET_BRIDGE_PORT', () => {
    const cmd = mgr.buildLaunchCommand(8123, 'tok', 'pane-1', {
      AWS_REGION: 'us-east-1',
      AWS_SECRET_ACCESS_KEY: `it's/a/secret`
    });
    expect(cmd).toMatch(
      /^AWS_REGION='us-east-1' AWS_SECRET_ACCESS_KEY='it'\\''s\/a\/secret' FLEET_BRIDGE_PORT=/
    );
  });

  it('serializes envOverrides in stable insertion order', () => {
    const cmd = mgr.buildLaunchCommand(0, '', '', { A: '1', B: '2', C: '3' });
    expect(cmd.indexOf(`A='1'`)).toBeLessThan(cmd.indexOf(`B='2'`));
    expect(cmd.indexOf(`B='2'`)).toBeLessThan(cmd.indexOf(`C='3'`));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pi-agent-manager`
Expected: FAIL — `posixShellQuote` not exported; `buildLaunchCommand` only takes 3 args.

- [ ] **Step 3: Implement `posixShellQuote` and extend `buildLaunchCommand`**

Edit `src/main/pi-agent-manager.ts`. Replace the existing `buildLaunchCommand` method (lines 92–107) with:

```ts
  buildLaunchCommand(
    bridgePort: number,
    bridgeToken: string,
    paneId: string,
    envOverrides: Record<string, string> = {}
  ): string {
    const extensionPaths = this.getExtensionPaths();
    const parts: string[] = [];

    for (const [key, value] of Object.entries(envOverrides)) {
      parts.push(`${key}=${posixShellQuote(value)}`);
    }

    parts.push(`FLEET_BRIDGE_PORT=${bridgePort}`);
    parts.push(`FLEET_BRIDGE_TOKEN=${bridgeToken}`);
    parts.push(`FLEET_PANE_ID=${paneId}`);

    parts.push(this.quoteArg(this.getBinPath()));

    for (const ext of extensionPaths) {
      parts.push('-e', this.quoteArg(ext));
    }

    return parts.join(' ');
  }
```

Also add an exported helper at the top of the file (below the imports):

```ts
/** POSIX-safe single-quote wrapping. Any internal `'` becomes `'\''`. */
export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pi-agent-manager`
Expected: PASS (7 tests: 4 quote + 3 command).

- [ ] **Step 5: Commit**

```bash
git add src/main/pi-agent-manager.ts src/main/__tests__/pi-agent-manager.test.ts
git commit -m "feat(pi): posixShellQuote + envOverrides param on buildLaunchCommand"
```

---

## Task 3: `PiEnvInjectionManager` — write/read/redact/clear

**Files:**

- Create: `src/main/pi-env-injection-manager.ts`
- Extend: `src/main/__tests__/pi-env-injection-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/__tests__/pi-env-injection-manager.test.ts`:

```ts
import { PiEnvInjectionManager } from '../pi-env-injection-manager';
import type { PiEnvInjection } from '../../shared/pi-env-injection-types';

/** In-memory store for tests; matches the subset of electron-store used by the manager. */
class FakeStore {
  private data: PiEnvInjection = {};
  get(): PiEnvInjection {
    return this.data;
  }
  set(next: PiEnvInjection): void {
    this.data = next;
  }
}

/** Deterministic safeStorage fake: prepends a marker so encrypt/decrypt are distinguishable. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => {
    const s = buf.toString('utf-8');
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
    return s.slice(4);
  }
};

describe('PiEnvInjectionManager — writeBedrock/getRedactedConfig', () => {
  it('round-trips plaintext fields and marks secret fields as present', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });

    mgr.writeBedrock({
      mode: 'keys',
      region: 'us-west-2',
      accessKeyId: 'AKIA…',
      secretAccessKey: 'SECRET!'
    });

    const redacted = mgr.getRedactedConfig().bedrock;
    expect(redacted).toEqual({
      mode: 'keys',
      region: 'us-west-2',
      accessKeyId: 'AKIA…',
      secretAccessKeyPresent: true,
      sessionTokenPresent: false
    });
  });

  it('encrypts secrets before persisting', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });

    mgr.writeBedrock({ mode: 'keys', secretAccessKey: 'plaintext-secret' });

    const raw = store.get();
    expect(raw.bedrock?.secretAccessKeyEnc).toBeDefined();
    expect(raw.bedrock?.secretAccessKeyEnc).not.toContain('plaintext-secret');
  });

  it('clearBedrockSecret removes only the named field', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });

    mgr.writeBedrock({
      mode: 'keys',
      secretAccessKey: 'sek',
      sessionToken: 'st'
    });
    mgr.clearBedrockSecret('secretAccessKey');

    const redacted = mgr.getRedactedConfig().bedrock;
    expect(redacted?.secretAccessKeyPresent).toBe(false);
    expect(redacted?.sessionTokenPresent).toBe(true);
  });

  it('write with safeStorage unavailable throws when secrets are supplied', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({
      store,
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false }
    });

    expect(() => mgr.writeBedrock({ mode: 'keys', secretAccessKey: 'x' })).toThrow(/encryption/i);
  });

  it('write with safeStorage unavailable succeeds when no secrets are supplied', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({
      store,
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false }
    });

    expect(() =>
      mgr.writeBedrock({ mode: 'profile', profile: 'dev', region: 'us-east-1' })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pi-env-injection-manager`
Expected: FAIL — `PiEnvInjectionManager` not found.

- [ ] **Step 3: Implement the manager**

Create `src/main/pi-env-injection-manager.ts`:

```ts
import Store from 'electron-store';
import { safeStorage } from 'electron';
import {
  PiEnvInjectionSchema,
  type PiEnvInjection,
  type PiBedrockInjection,
  type RedactedBedrock,
  type BedrockWritePatch
} from '../shared/pi-env-injection-types';
import { createLogger } from './logger';

const log = createLogger('pi-env-injection');

export type { BedrockWritePatch };

interface EnvInjectionStore {
  get(): PiEnvInjection;
  set(next: PiEnvInjection): void;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

type PiEnvInjectionManagerOptions = {
  store?: EnvInjectionStore;
  safeStorage?: SafeStorageLike;
};

function defaultStore(): EnvInjectionStore {
  const store = new Store<{ data: PiEnvInjection }>({
    name: 'fleet-pi-env-injection',
    defaults: { data: {} }
  });
  return {
    get: () => store.get('data'),
    set: (next) => store.set('data', next)
  };
}

export class PiEnvInjectionManager {
  private readonly store: EnvInjectionStore;
  private readonly safe: SafeStorageLike;

  constructor(opts: PiEnvInjectionManagerOptions = {}) {
    this.store = opts.store ?? defaultStore();
    this.safe = opts.safeStorage ?? safeStorage;
  }

  getRedactedConfig(): { bedrock?: RedactedBedrock } {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    if (!raw.bedrock) return {};
    return {
      bedrock: {
        mode: raw.bedrock.mode,
        region: raw.bedrock.region,
        profile: raw.bedrock.profile,
        accessKeyId: raw.bedrock.accessKeyId,
        secretAccessKeyPresent: Boolean(raw.bedrock.secretAccessKeyEnc),
        sessionTokenPresent: Boolean(raw.bedrock.sessionTokenEnc)
      }
    };
  }

  writeBedrock(patch: BedrockWritePatch): void {
    const suppliesSecret =
      (patch.secretAccessKey !== undefined && patch.secretAccessKey !== '') ||
      (patch.sessionToken !== undefined && patch.sessionToken !== '');
    if (suppliesSecret && !this.safe.isEncryptionAvailable()) {
      throw new Error('OS keychain encryption is unavailable; cannot store AWS secret.');
    }

    const raw = PiEnvInjectionSchema.parse(this.store.get());
    const current: PiBedrockInjection = raw.bedrock ?? { mode: 'chain' };

    const next: PiBedrockInjection = {
      mode: patch.mode ?? current.mode,
      region: patch.region !== undefined ? patch.region || undefined : current.region,
      profile: patch.profile !== undefined ? patch.profile || undefined : current.profile,
      accessKeyId:
        patch.accessKeyId !== undefined ? patch.accessKeyId || undefined : current.accessKeyId,
      secretAccessKeyEnc: current.secretAccessKeyEnc,
      sessionTokenEnc: current.sessionTokenEnc
    };

    if (patch.secretAccessKey !== undefined) {
      next.secretAccessKeyEnc =
        patch.secretAccessKey === ''
          ? undefined
          : this.safe.encryptString(patch.secretAccessKey).toString('base64');
    }
    if (patch.sessionToken !== undefined) {
      next.sessionTokenEnc =
        patch.sessionToken === ''
          ? undefined
          : this.safe.encryptString(patch.sessionToken).toString('base64');
    }

    this.store.set({ ...raw, bedrock: next });
  }

  clearBedrockSecret(field: 'secretAccessKey' | 'sessionToken'): void {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    if (!raw.bedrock) return;
    const next: PiBedrockInjection = { ...raw.bedrock };
    if (field === 'secretAccessKey') next.secretAccessKeyEnc = undefined;
    if (field === 'sessionToken') next.sessionTokenEnc = undefined;
    this.store.set({ ...raw, bedrock: next });
  }

  /** Main-process only. Decrypts on demand; skips fields that fail to decrypt. */
  getInjectedEnv(): Record<string, string> {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    const out: Record<string, string> = {};
    const b = raw.bedrock;
    if (!b) return out;

    if (b.region) out.AWS_REGION = b.region;

    if (b.mode === 'profile') {
      if (b.profile) out.AWS_PROFILE = b.profile;
    } else if (b.mode === 'keys') {
      if (b.accessKeyId) out.AWS_ACCESS_KEY_ID = b.accessKeyId;
      if (b.secretAccessKeyEnc) {
        try {
          out.AWS_SECRET_ACCESS_KEY = this.safe.decryptString(
            Buffer.from(b.secretAccessKeyEnc, 'base64')
          );
        } catch (err) {
          log.warn('Failed to decrypt AWS_SECRET_ACCESS_KEY; skipping', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      if (b.sessionTokenEnc) {
        try {
          out.AWS_SESSION_TOKEN = this.safe.decryptString(Buffer.from(b.sessionTokenEnc, 'base64'));
        } catch (err) {
          log.warn('Failed to decrypt AWS_SESSION_TOKEN; skipping', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
    // 'chain' mode: only AWS_REGION above (if set), nothing else.

    return out;
  }

  isEncryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pi-env-injection-manager`
Expected: PASS (8 tests total: 3 from Task 1 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/pi-env-injection-manager.ts src/main/__tests__/pi-env-injection-manager.test.ts
git commit -m "feat(pi): PiEnvInjectionManager with safeStorage-backed Bedrock creds"
```

---

## Task 4: `getInjectedEnv` decryption + mode behavior tests

**Files:**

- Extend: `src/main/__tests__/pi-env-injection-manager.test.ts`

- [ ] **Step 1: Add behavior tests**

Append to `src/main/__tests__/pi-env-injection-manager.test.ts`:

```ts
describe('PiEnvInjectionManager.getInjectedEnv', () => {
  const buildMgr = (bedrock: PiEnvInjection['bedrock']): PiEnvInjectionManager => {
    const store = new FakeStore();
    store.set({ bedrock });
    return new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });
  };

  it('mode=chain writes only AWS_REGION when present', () => {
    const mgr = buildMgr({ mode: 'chain', region: 'eu-central-1' });
    expect(mgr.getInjectedEnv()).toEqual({ AWS_REGION: 'eu-central-1' });
  });

  it('mode=chain with no region writes nothing', () => {
    const mgr = buildMgr({ mode: 'chain' });
    expect(mgr.getInjectedEnv()).toEqual({});
  });

  it('mode=profile writes AWS_PROFILE + AWS_REGION', () => {
    const mgr = buildMgr({ mode: 'profile', profile: 'dev', region: 'us-east-1' });
    expect(mgr.getInjectedEnv()).toEqual({ AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' });
  });

  it('mode=keys decrypts secretAccessKey and sessionToken', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });
    mgr.writeBedrock({
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      sessionToken: 'tok'
    });
    expect(mgr.getInjectedEnv()).toEqual({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'shh',
      AWS_SESSION_TOKEN: 'tok'
    });
  });

  it('skips fields whose decryption throws', () => {
    const store = new FakeStore();
    store.set({
      bedrock: {
        mode: 'keys',
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKeyEnc: Buffer.from('corrupted').toString('base64')
      }
    });
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });
    expect(mgr.getInjectedEnv()).toEqual({ AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIA' });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- pi-env-injection-manager`
Expected: PASS (13 tests total).
No implementation change is needed — Task 3's `getInjectedEnv` already covers these cases. If any test fails, fix `getInjectedEnv` before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/main/__tests__/pi-env-injection-manager.test.ts
git commit -m "test(pi): behavior coverage for PiEnvInjectionManager.getInjectedEnv"
```

---

## Task 5: IPC channels + preload surface

**Files:**

- Modify: `src/shared/ipc-channels.ts` (end of Pi Agent section, around line 106)
- Modify: `src/preload/index.ts` (after `piConfig`, around line 352)

- [ ] **Step 1: Add IPC channel constants**

Edit `src/shared/ipc-channels.ts`. Replace the closing `PI_CONFIG_OPEN_FOLDER: 'pi:config:open-folder'` line (and its trailing `}`) with:

```ts
  PI_CONFIG_OPEN_FOLDER: 'pi:config:open-folder',
  // Pi Env Injection
  PI_ENV_READ_BEDROCK: 'pi:env:read-bedrock',
  PI_ENV_WRITE_BEDROCK: 'pi:env:write-bedrock',
  PI_ENV_CLEAR_SECRET: 'pi:env:clear-secret',
  PI_ENV_IS_ENCRYPTION_AVAILABLE: 'pi:env:is-encryption-available'
} as const;
```

- [ ] **Step 2: Expose the channels on preload**

Edit `src/preload/index.ts`. Add after the `piConfig: { ... }` block (before the closing `}` of `fleetApi`):

```ts
  ,
  piEnv: {
    readBedrock: async (): Promise<RedactedBedrock | undefined> =>
      (await typedInvoke<{ bedrock?: RedactedBedrock }>(IPC_CHANNELS.PI_ENV_READ_BEDROCK)).bedrock,
    writeBedrock: async (patch: BedrockWritePatch): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_ENV_WRITE_BEDROCK, patch),
    clearSecret: async (field: 'secretAccessKey' | 'sessionToken'): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_ENV_CLEAR_SECRET, field),
    isEncryptionAvailable: async (): Promise<boolean> =>
      typedInvoke(IPC_CHANNELS.PI_ENV_IS_ENCRYPTION_AVAILABLE)
  }
```

Add the two type imports near the other pi-config type imports (around line 42 in `src/preload/index.ts`):

```ts
import type { RedactedBedrock, BedrockWritePatch } from '../shared/pi-env-injection-types';
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/preload/index.ts
git commit -m "feat(pi): PI_ENV_* IPC channels + preload surface"
```

---

## Task 6: Wire IPC handlers + inject env into `PI_LAUNCH_CONFIG`

**Files:**

- Modify: `src/main/ipc-handlers.ts` (handler registration around line 499; module signature around line 73)
- Modify: `src/main/index.ts` (around line 62)

- [ ] **Step 1: Instantiate the manager in `index.ts`**

Edit `src/main/index.ts`.

Add the import near the other pi-agent/pi-config imports (around line 26):

```ts
import { PiEnvInjectionManager } from './pi-env-injection-manager';
```

Add the instantiation directly below `piConfigManager` (around line 63):

```ts
const piEnvInjectionManager = new PiEnvInjectionManager();
```

Extend the `registerIpcHandlers(...)` call (around lines 303–322). It currently ends with `piAuthInspector` as the last positional arg. Add `piEnvInjectionManager` as the new last positional arg:

```ts
registerIpcHandlers(
  ptyManager,
  layoutStore,
  eventBus,
  notificationDetector,
  notificationState,
  settingsStore,
  cwdPoller,
  gitService,
  () => mainWindow,
  workspacePath,
  activityTracker,
  new WorktreeService(),
  annotationStore,
  annotateService,
  piAgentManager,
  fleetBridge,
  piConfigManager,
  piAuthInspector,
  piEnvInjectionManager
);
```

- [ ] **Step 2: Extend the handlers signature and wire the new channels**

Edit `src/main/ipc-handlers.ts`:

Add the import near line 44 (with the other type-only manager imports):

```ts
import type { PiEnvInjectionManager } from './pi-env-injection-manager';
```

In the `registerIpcHandlers` function signature (parameter list starting around line 73), add `piEnvInjectionManager: PiEnvInjectionManager,` as the new last parameter, matching the positional order of the call site in `index.ts`.

Replace the existing `PI_LAUNCH_CONFIG` handler (around line 499) with:

```ts
ipcMain.handle(IPC_CHANNELS.PI_LAUNCH_CONFIG, async (_event, req: { paneId: string }) => {
  await piAgentManager.ensureInstalled();
  const token = fleetBridge.generateToken();
  const port = fleetBridge.getPort();
  const env = piEnvInjectionManager.getInjectedEnv();
  const cmd = piAgentManager.buildLaunchCommand(port, token, req.paneId, env);
  return { cmd };
});
```

Then, after the last `piConfig` handler (search for `PI_CONFIG_OPEN_FOLDER`), register the four new `piEnv` handlers:

```ts
ipcMain.handle(IPC_CHANNELS.PI_ENV_READ_BEDROCK, () => {
  return piEnvInjectionManager.getRedactedConfig();
});

ipcMain.handle(
  IPC_CHANNELS.PI_ENV_WRITE_BEDROCK,
  (_event, patch: import('../shared/pi-env-injection-types').BedrockWritePatch) => {
    piEnvInjectionManager.writeBedrock(patch);
  }
);

ipcMain.handle(
  IPC_CHANNELS.PI_ENV_CLEAR_SECRET,
  (_event, field: 'secretAccessKey' | 'sessionToken') => {
    piEnvInjectionManager.clearBedrockSecret(field);
  }
);

ipcMain.handle(IPC_CHANNELS.PI_ENV_IS_ENCRYPTION_AVAILABLE, () => {
  return piEnvInjectionManager.isEncryptionAvailable();
});
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat(pi): wire env-injection handlers and apply env to Pi launch"
```

---

## Task 7: `pi-presets.ts` — remove Bedrock preset, add `managedEnv` flag

**Files:**

- Modify: `src/shared/pi-presets.ts`

- [ ] **Step 1: Remove `bedrock` from `PI_PRESETS` and remove the `'bedrock'` preset id**

Edit `src/shared/pi-presets.ts`. Change the `PiPresetId` union (lines 3-9) to drop `'bedrock'`:

```ts
export type PiPresetId = 'ollama' | 'lm-studio' | 'openrouter' | 'vercel-gateway' | 'custom';
```

Delete the entire `bedrock` object from `PI_PRESETS` (lines 26-36 in the original — the first entry with `id: 'bedrock'`).

- [ ] **Step 2: Add `managedEnv` flag to the Bedrock entry in `PI_BUILT_IN_PROVIDERS`**

Still in `src/shared/pi-presets.ts`, extend the built-in provider type and set the flag. Replace the `PI_BUILT_IN_PROVIDERS` type declaration with:

```ts
export const PI_BUILT_IN_PROVIDERS: Array<{
  id: string;
  label: string;
  envVar?: string;
  supportsOAuth?: boolean;
  managedEnv?: boolean;
  hint?: string;
}> = [
```

And in the Bedrock entry (search for `id: 'bedrock'` inside `PI_BUILT_IN_PROVIDERS`), set:

```ts
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    envVar: 'AWS_REGION',
    managedEnv: true,
    hint: 'Configured in Fleet: credentials are stored in the OS keychain and injected into Pi tabs Fleet opens.'
  },
```

- [ ] **Step 3: Fix the fallout in `PiCustomProvidersList`**

Edit `src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx` (around line 22). Remove the bedrock branch in `inferPresetId`:

```ts
function inferPresetId(id: string, provider: PiProvider): PiPresetId {
  const url = provider.baseUrl ?? '';
  if (url.includes('11434')) return 'ollama';
  if (url.includes('1234')) return 'lm-studio';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('ai-gateway.vercel.sh')) return 'vercel-gateway';
  return 'custom';
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. If any other file references `PI_PRESETS` with `bedrock`, the typecheck will point to it — fix by removing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/pi-presets.ts src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx
git commit -m "refactor(pi): remove Bedrock from custom-provider preset, mark as managed"
```

---

## Task 8: Provider-row ordering — pure function + unit tests

**Files:**

- Create: `src/renderer/src/components/settings/pi/lib/provider-ordering.ts`
- Create: `src/renderer/src/components/settings/pi/__tests__/provider-ordering.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/settings/pi/__tests__/provider-ordering.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { orderProviderRows, type ProviderRowInput } from '../lib/provider-ordering';

const row = (
  id: string,
  kind: ProviderRowInput['kind'],
  configured: boolean
): ProviderRowInput => ({
  id,
  label: id,
  kind,
  configured
});

describe('orderProviderRows', () => {
  it('puts configured rows (built-in and custom) alphabetically in the primary tier', () => {
    const out = orderProviderRows([
      row('zeta-custom', 'custom', true),
      row('anthropic', 'oauth-builtin', true),
      row('bedrock', 'managed-builtin', false),
      row('ollama', 'env-builtin-readonly', false)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual(['anthropic', 'zeta-custom']);
  });

  it('adds primary unconfigured built-ins after configured rows, alphabetical', () => {
    const out = orderProviderRows([
      row('anthropic', 'oauth-builtin', true),
      row('bedrock', 'managed-builtin', false),
      row('ollama', 'env-builtin-readonly', false),
      row('openai', 'oauth-builtin', false),
      row('google', 'oauth-builtin', false),
      row('openrouter', 'env-builtin-readonly', false)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual([
      'anthropic',
      'bedrock',
      'google',
      'ollama',
      'openai',
      'openrouter'
    ]);
  });

  it('collects secondary built-ins into `secondary` (hidden behind Show more)', () => {
    const out = orderProviderRows([
      row('azure', 'env-builtin-readonly', false),
      row('mistral', 'env-builtin-readonly', false),
      row('xai', 'env-builtin-readonly', false),
      row('anthropic', 'oauth-builtin', true)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual(['anthropic']);
    expect(out.secondary.map((r) => r.id)).toEqual(['azure', 'mistral', 'xai']);
  });

  it('a configured secondary built-in is promoted into primary', () => {
    const out = orderProviderRows([
      row('azure', 'env-builtin-readonly', true),
      row('anthropic', 'oauth-builtin', true)
    ]);
    expect(out.primary.map((r) => r.id)).toEqual(['anthropic', 'azure']);
    expect(out.secondary).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- provider-ordering`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/components/settings/pi/lib/provider-ordering.ts`:

```ts
export type ProviderRowKind =
  | 'oauth-builtin'
  | 'managed-builtin'
  | 'env-builtin-readonly'
  | 'custom';

export type ProviderRowInput = {
  id: string;
  label: string;
  kind: ProviderRowKind;
  configured: boolean;
};

export type OrderedProviderRows<T extends ProviderRowInput> = {
  primary: T[];
  secondary: T[];
};

const PRIMARY_BUILTIN_IDS = new Set([
  'anthropic',
  'bedrock',
  'google',
  'ollama',
  'openai',
  'openrouter'
]);

export function orderProviderRows<T extends ProviderRowInput>(rows: T[]): OrderedProviderRows<T> {
  const primary: T[] = [];
  const secondary: T[] = [];

  for (const row of rows) {
    const isPrimaryTier =
      row.configured || row.kind === 'custom' || PRIMARY_BUILTIN_IDS.has(row.id);
    if (isPrimaryTier) {
      primary.push(row);
    } else {
      secondary.push(row);
    }
  }

  const byLabel = (a: T, b: T): number => a.label.localeCompare(b.label);
  primary.sort(byLabel);
  secondary.sort(byLabel);

  return { primary, secondary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- provider-ordering`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/pi/lib/provider-ordering.ts src/renderer/src/components/settings/pi/__tests__/provider-ordering.test.ts
git commit -m "feat(pi): unified provider row ordering as a pure function"
```

---

## Task 9: `PiWelcomeStrip` component

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiWelcomeStrip.tsx`

- [ ] **Step 1: Implement**

Create `src/renderer/src/components/settings/pi/PiWelcomeStrip.tsx`:

```tsx
type Props = {
  onPick: (providerId: 'anthropic' | 'bedrock' | 'ollama') => void;
  onShowMore: () => void;
};

export function PiWelcomeStrip({ onPick, onShowMore }: Props): React.JSX.Element {
  return (
    <section className="rounded border border-blue-900/40 bg-blue-950/20 px-4 py-3 space-y-2">
      <h2 className="text-sm font-semibold text-neutral-100">Start here</h2>
      <p className="text-xs text-neutral-400">
        Pi needs at least one provider configured before you can run it in a tab.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onPick('anthropic')}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 text-left min-w-[140px]"
        >
          <div className="font-medium">Anthropic</div>
          <div className="text-xs text-neutral-500">Sign in with a Claude subscription</div>
        </button>
        <button
          type="button"
          onClick={() => onPick('bedrock')}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 text-left min-w-[140px]"
        >
          <div className="font-medium">Amazon Bedrock</div>
          <div className="text-xs text-neutral-500">Use your AWS account</div>
        </button>
        <button
          type="button"
          onClick={() => onPick('ollama')}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-800 text-left min-w-[140px]"
        >
          <div className="font-medium">Ollama (local)</div>
          <div className="text-xs text-neutral-500">Run models on this machine</div>
        </button>
        <button
          type="button"
          onClick={onShowMore}
          className="text-xs text-neutral-400 underline hover:text-neutral-200 self-center"
        >
          more providers ▸
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiWelcomeStrip.tsx
git commit -m "feat(pi): PiWelcomeStrip zero-state onboarding component"
```

---

## Task 10: `PiBedrockPanel` component — form for managed env injection

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiBedrockPanel.tsx`

- [ ] **Step 1: Implement**

Create `src/renderer/src/components/settings/pi/PiBedrockPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type {
  BedrockWritePatch,
  PiBedrockCredentialMode,
  RedactedBedrock
} from '../../../../../shared/pi-env-injection-types';

type Props = {
  legacyCustomProviderPresent: boolean;
  onLegacyMigrate: () => void | Promise<void>;
  onLegacyKeepAsCustom: () => void;
};

type Loaded = {
  kind: 'loaded';
  mode: PiBedrockCredentialMode;
  region: string;
  profile: string;
  accessKeyId: string;
  secretAccessKeyPresent: boolean;
  sessionTokenPresent: boolean;
  encryptionAvailable: boolean;
};

type State = { kind: 'loading' } | Loaded | { kind: 'error'; message: string };

export function PiBedrockPanel({
  legacyCustomProviderPresent,
  onLegacyMigrate,
  onLegacyKeepAsCustom
}: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [secretDraft, setSecretDraft] = useState('');
  const [sessionDraft, setSessionDraft] = useState('');
  const [legacyBannerDismissed, setLegacyBannerDismissed] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const [redacted, encryptionAvailable] = await Promise.all([
        window.fleet.piEnv.readBedrock(),
        window.fleet.piEnv.isEncryptionAvailable()
      ]);
      const r: RedactedBedrock = redacted ?? {
        mode: 'chain',
        secretAccessKeyPresent: false,
        sessionTokenPresent: false
      };
      setState({
        kind: 'loaded',
        mode: r.mode,
        region: r.region ?? '',
        profile: r.profile ?? '',
        accessKeyId: r.accessKeyId ?? '',
        secretAccessKeyPresent: r.secretAccessKeyPresent,
        sessionTokenPresent: r.sessionTokenPresent,
        encryptionAvailable
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (state.kind === 'loading') {
    return <div className="text-xs text-neutral-500 px-3 py-2">Loading Bedrock settings…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="text-xs text-red-400 px-3 py-2">
        Failed to load Bedrock settings: {state.message}
      </div>
    );
  }

  const writePatch = async (patch: BedrockWritePatch): Promise<void> => {
    await window.fleet.piEnv.writeBedrock(patch);
    await load();
  };

  const writeSecret = async (
    field: 'secretAccessKey' | 'sessionToken',
    value: string
  ): Promise<void> => {
    await writePatch({ [field]: value });
    if (field === 'secretAccessKey') setSecretDraft('');
    else setSessionDraft('');
  };

  const clearSecret = async (field: 'secretAccessKey' | 'sessionToken'): Promise<void> => {
    await window.fleet.piEnv.clearSecret(field);
    await load();
  };

  const showKeysFields = state.mode === 'keys';
  const showProfileField = state.mode === 'profile';

  return (
    <div className="space-y-3 px-3 py-3">
      {legacyCustomProviderPresent && !legacyBannerDismissed && (
        <div className="rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 space-y-2">
          <p>
            We detected an existing <code>bedrock</code> entry under custom providers. Move its
            custom model ids into this panel?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onLegacyMigrate()}
              className="rounded bg-amber-700 px-2 py-1 text-white hover:bg-amber-600"
            >
              Move
            </button>
            <button
              type="button"
              onClick={() => {
                setLegacyBannerDismissed(true);
                onLegacyKeepAsCustom();
              }}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              Keep as custom
            </button>
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-neutral-400 block mb-1">AWS Region</label>
        <input
          type="text"
          value={state.region}
          onChange={(e) => setState({ ...state, region: e.target.value })}
          onBlur={() => void writePatch({ region: state.region })}
          placeholder="us-east-1"
          className="w-64 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        <p className="text-xs text-neutral-600 mt-1">
          Overrides any value in your shell for Fleet-launched Pi tabs.
        </p>
      </div>

      <fieldset>
        <legend className="text-xs text-neutral-400 mb-1">Credentials</legend>
        <div className="space-y-1 text-sm text-neutral-200">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="bedrock-mode"
              checked={state.mode === 'profile'}
              onChange={() => void writePatch({ mode: 'profile' })}
            />
            Use AWS profile (recommended)
          </label>
          <label
            className={`flex items-center gap-2 ${state.encryptionAvailable ? '' : 'opacity-50'}`}
          >
            <input
              type="radio"
              name="bedrock-mode"
              disabled={!state.encryptionAvailable}
              checked={state.mode === 'keys'}
              onChange={() => void writePatch({ mode: 'keys' })}
            />
            Use access keys
            {!state.encryptionAvailable && (
              <span className="text-xs text-neutral-500">(OS keychain unavailable)</span>
            )}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="bedrock-mode"
              checked={state.mode === 'chain'}
              onChange={() => void writePatch({ mode: 'chain' })}
            />
            Use credential chain (inherit from shell)
          </label>
        </div>
      </fieldset>

      {showProfileField && (
        <div>
          <label className="text-xs text-neutral-400 block mb-1">AWS Profile</label>
          <input
            type="text"
            value={state.profile}
            onChange={(e) => setState({ ...state, profile: e.target.value })}
            onBlur={() => void writePatch({ profile: state.profile })}
            placeholder="default"
            className="w-64 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          />
        </div>
      )}

      {showKeysFields && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Access Key ID</label>
            <input
              type="text"
              value={state.accessKeyId}
              onChange={(e) => setState({ ...state, accessKeyId: e.target.value })}
              onBlur={() => void writePatch({ accessKeyId: state.accessKeyId })}
              className="w-80 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">
              Secret Access Key <span className="text-neutral-600">🔒 stored in OS keychain</span>
            </label>
            {state.secretAccessKeyPresent ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-300">●●●●●●●● (set)</span>
                <button
                  type="button"
                  onClick={() => void clearSecret('secretAccessKey')}
                  className="text-xs rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setState({ ...state, secretAccessKeyPresent: false });
                  }}
                  className="text-xs rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                >
                  Replace
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={secretDraft}
                  onChange={(e) => setSecretDraft(e.target.value)}
                  className="w-80 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
                />
                <button
                  type="button"
                  disabled={!secretDraft}
                  onClick={() => void writeSecret('secretAccessKey', secretDraft)}
                  className="text-xs rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500"
                >
                  Save
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">
              Session Token <span className="text-neutral-600">optional · STS · 🔒 encrypted</span>
            </label>
            {state.sessionTokenPresent ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-300">●●●●●●●● (set)</span>
                <button
                  type="button"
                  onClick={() => void clearSecret('sessionToken')}
                  className="text-xs rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                >
                  Clear
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={sessionDraft}
                  onChange={(e) => setSessionDraft(e.target.value)}
                  className="w-80 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
                />
                <button
                  type="button"
                  disabled={!sessionDraft}
                  onClick={() => void writeSecret('sessionToken', sessionDraft)}
                  className="text-xs rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-neutral-500">
        These values are injected into Pi tabs Fleet opens. They do not affect the <code>pi</code>{' '}
        CLI you run in a terminal.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiBedrockPanel.tsx
git commit -m "feat(pi): PiBedrockPanel with keychain-backed AWS credentials"
```

---

## Task 11: `PiProviderRow` — row chrome + expansion dispatcher

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiProviderRow.tsx`

- [ ] **Step 1: Implement**

Create `src/renderer/src/components/settings/pi/PiProviderRow.tsx`:

```tsx
import { useState } from 'react';
import type { PiModelsFile, PiProvider } from '../../../../../shared/pi-config-types';
import { PiProviderForm } from './PiProviderForm';
import { PiBedrockPanel } from './PiBedrockPanel';
import type { ProviderRowKind } from './lib/provider-ordering';

export type PiProviderRowProps = {
  id: string;
  label: string;
  kind: ProviderRowKind;
  statusText: string;
  dotColor: 'green' | 'amber' | 'grey';
  autoExpand?: boolean;

  // Only when kind === 'custom':
  customProvider?: PiProvider;
  allProviderIds?: string[];
  models?: PiModelsFile;
  onSaveCustom?: (id: string, provider: PiProvider) => Promise<void>;
  onDeleteCustom?: (id: string) => Promise<void>;

  // Only when kind === 'managed-builtin' (Bedrock):
  legacyCustomProviderPresent?: boolean;
  onLegacyMigrate?: () => void | Promise<void>;
  onLegacyKeepAsCustom?: () => void;
};

const dotClass: Record<PiProviderRowProps['dotColor'], string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  grey: 'bg-neutral-600'
};

export function PiProviderRow(props: PiProviderRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(Boolean(props.autoExpand));

  return (
    <div className="border border-neutral-800 rounded">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-900/40"
      >
        <span className={`w-2 h-2 rounded-full ${dotClass[props.dotColor]}`} aria-hidden />
        <span className="text-sm text-neutral-200 min-w-[140px]">{props.label}</span>
        {props.kind === 'custom' && (
          <span className="text-xs text-neutral-500 rounded bg-neutral-800 px-1.5 py-0.5">
            (c.)
          </span>
        )}
        <span className="text-xs text-neutral-500 flex-1">{props.statusText}</span>
        <span className="text-xs text-neutral-500">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-800">
          {props.kind === 'oauth-builtin' && <OAuthPanel label={props.label} />}
          {props.kind === 'env-builtin-readonly' && (
            <ReadonlyEnvPanel
              envVar={props.statusText.replace(/\s+set$|\s+not set$/i, '')}
              label={props.label}
            />
          )}
          {props.kind === 'managed-builtin' && (
            <PiBedrockPanel
              legacyCustomProviderPresent={props.legacyCustomProviderPresent ?? false}
              onLegacyMigrate={props.onLegacyMigrate ?? (() => undefined)}
              onLegacyKeepAsCustom={props.onLegacyKeepAsCustom ?? (() => undefined)}
            />
          )}
          {props.kind === 'custom' &&
            props.customProvider &&
            props.onSaveCustom &&
            props.onDeleteCustom &&
            props.allProviderIds && (
              <PiProviderForm
                initialId={props.id}
                initialProvider={props.customProvider}
                presetId="custom"
                existingIds={props.allProviderIds.filter((x) => x !== props.id)}
                onSave={async (nid, np) => props.onSaveCustom?.(nid, np)}
                onDelete={async () => props.onDeleteCustom?.(props.id)}
                onCancel={() => setExpanded(false)}
              />
            )}
        </div>
      )}
    </div>
  );
}

function OAuthPanel({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="px-3 py-3 text-sm text-neutral-300 space-y-2">
      <p>{label} uses OAuth. Sign in via the pi CLI:</p>
      <code className="block rounded bg-neutral-900 px-2 py-1 text-xs text-neutral-200">pi</code>
      <p className="text-xs text-neutral-500">
        Then type <code>/login</code> and follow the prompts. Come back here afterwards — auth
        status refreshes on window focus.
      </p>
    </div>
  );
}

function ReadonlyEnvPanel({ envVar, label }: { envVar: string; label: string }): React.JSX.Element {
  return (
    <div className="px-3 py-3 text-sm text-neutral-300 space-y-2">
      <p>
        {label} uses an environment variable. Set <code>{envVar}</code> in the shell you launch
        Fleet from.
      </p>
      <p className="text-xs text-neutral-500">
        Fleet-managed injection for this provider isn&apos;t available yet.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiProviderRow.tsx
git commit -m "feat(pi): PiProviderRow with kind-dispatched expansion panel"
```

---

## Task 12: `PiProvidersList` — unified list composition

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiProvidersList.tsx`

- [ ] **Step 1: Implement**

Create `src/renderer/src/components/settings/pi/PiProvidersList.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type {
  BuiltInProviderStatus,
  PiModelsFile,
  PiProvider
} from '../../../../../shared/pi-config-types';
import { PI_BUILT_IN_PROVIDERS, type PiPresetId } from '../../../../../shared/pi-presets';
import {
  orderProviderRows,
  type ProviderRowInput,
  type ProviderRowKind
} from './lib/provider-ordering';
import { PiProviderRow } from './PiProviderRow';
import { PiPresetPicker } from './PiPresetPicker';

type Props = {
  builtIn: BuiltInProviderStatus[];
  models: PiModelsFile;
  bedrockHasEnvConfig: boolean;
  autoExpandId: string | null;
  onExpandConsumed: () => void;
  onAddCustom: (presetId: PiPresetId) => void;
  onSaveCustom: (id: string, provider: PiProvider) => Promise<void>;
  onDeleteCustom: (id: string) => Promise<void>;
  onLegacyMigrate: () => Promise<void>;
  onLegacyKeepAsCustom: () => void;
};

function inferKind(id: string): ProviderRowKind {
  const meta = PI_BUILT_IN_PROVIDERS.find((p) => p.id === id);
  if (!meta) return 'custom';
  if (meta.managedEnv) return 'managed-builtin';
  if (meta.supportsOAuth) return 'oauth-builtin';
  return 'env-builtin-readonly';
}

function bedrockDot(
  status: BuiltInProviderStatus,
  hasEnvConfig: boolean
): 'green' | 'amber' | 'grey' {
  if (status.authenticated) return 'green';
  if (hasEnvConfig) return 'amber';
  return 'grey';
}

export function PiProvidersList(props: Props): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [secondaryOpen, setSecondaryOpen] = useState(false);

  const legacyBedrockProvider: PiProvider | undefined = props.models.providers['bedrock'];

  const customIds = useMemo(() => {
    return Object.keys(props.models.providers).filter((id) => id !== 'bedrock');
  }, [props.models]);

  const rows: ProviderRowInput[] = useMemo(() => {
    const byId = new Map<string, BuiltInProviderStatus>();
    for (const s of props.builtIn) byId.set(s.id, s);

    const builtInRows: ProviderRowInput[] = PI_BUILT_IN_PROVIDERS.map((meta) => {
      const status = byId.get(meta.id);
      const configured = Boolean(status?.authenticated);
      return {
        id: meta.id,
        label: meta.label,
        kind: inferKind(meta.id),
        configured: meta.id === 'bedrock' ? configured || props.bedrockHasEnvConfig : configured
      };
    });

    const customRows: ProviderRowInput[] = customIds.map((id) => ({
      id,
      label: id,
      kind: 'custom',
      configured: Boolean(props.models.providers[id]?.apiKey || props.models.providers[id]?.baseUrl)
    }));

    return [...builtInRows, ...customRows];
  }, [props.builtIn, props.models, customIds, props.bedrockHasEnvConfig]);

  const ordered = useMemo(() => orderProviderRows(rows), [rows]);

  const renderRow = (row: ProviderRowInput): React.JSX.Element => {
    const status = props.builtIn.find((s) => s.id === row.id);
    const autoExpand = props.autoExpandId === row.id;
    let statusText = '';
    let dot: 'green' | 'amber' | 'grey' = 'grey';

    if (row.kind === 'oauth-builtin') {
      statusText = status?.authenticated
        ? 'OAuth'
        : status?.envVarName
          ? `Set ${status.envVarName} or run /login`
          : 'Not authenticated';
      dot = status?.authenticated ? 'green' : 'grey';
    } else if (row.kind === 'env-builtin-readonly') {
      statusText = status?.authenticated
        ? `${status.envVarName} set`
        : status?.envVarName
          ? `Set ${status.envVarName} in your shell`
          : 'Not configured';
      dot = status?.authenticated ? 'green' : 'grey';
    } else if (row.kind === 'managed-builtin') {
      statusText = status?.authenticated
        ? 'Configured (env injection)'
        : props.bedrockHasEnvConfig
          ? 'Partial (needs region or creds)'
          : 'Not configured';
      dot = status ? bedrockDot(status, props.bedrockHasEnvConfig) : 'grey';
    } else {
      const provider = props.models.providers[row.id];
      const modelCount = provider?.models?.length ?? 0;
      statusText = modelCount ? `${modelCount} model${modelCount === 1 ? '' : 's'}` : 'custom';
      dot = provider?.apiKey || provider?.baseUrl ? 'green' : 'amber';
    }

    const common = {
      id: row.id,
      label: row.label,
      kind: row.kind,
      statusText,
      dotColor: dot,
      autoExpand
    };

    if (row.kind === 'custom') {
      return (
        <div key={row.id}>
          <PiProviderRow
            {...common}
            customProvider={props.models.providers[row.id]}
            allProviderIds={Object.keys(props.models.providers)}
            models={props.models}
            onSaveCustom={props.onSaveCustom}
            onDeleteCustom={props.onDeleteCustom}
          />
        </div>
      );
    }
    if (row.kind === 'managed-builtin') {
      return (
        <div key={row.id}>
          <PiProviderRow
            {...common}
            legacyCustomProviderPresent={Boolean(legacyBedrockProvider)}
            onLegacyMigrate={props.onLegacyMigrate}
            onLegacyKeepAsCustom={props.onLegacyKeepAsCustom}
          />
        </div>
      );
    }
    return (
      <div key={row.id}>
        <PiProviderRow {...common} />
      </div>
    );
  };

  // After the list re-renders with a row autoExpanded, clear the parent's autoExpand state
  // so subsequent state changes don't keep re-triggering expansion on the same row.
  useEffect(() => {
    if (props.autoExpandId !== null) {
      props.onExpandConsumed();
    }
  }, [props.autoExpandId, props.onExpandConsumed]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-neutral-200">Providers</h2>
          <p className="text-xs text-neutral-500">
            Each provider needs credentials or an auth method. Click a row to configure.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white"
        >
          + Add custom
        </button>
      </div>

      <div className="space-y-2">
        {ordered.primary.map(renderRow)}
        {ordered.secondary.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setSecondaryOpen((o) => !o)}
              className="text-xs text-neutral-400 hover:text-neutral-200 underline"
            >
              {secondaryOpen ? 'Hide' : `Show ${ordered.secondary.length} more providers`}
            </button>
            {secondaryOpen && <div className="space-y-2">{ordered.secondary.map(renderRow)}</div>}
          </>
        )}
      </div>

      {pickerOpen && (
        <PiPresetPicker
          onPick={(presetId) => {
            setPickerOpen(false);
            props.onAddCustom(presetId);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiProvidersList.tsx
git commit -m "feat(pi): unified PiProvidersList merging built-in and custom rows"
```

---

## Task 13: `PiAdvancedAccordion` — collapsed advanced region

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiAdvancedAccordion.tsx`

- [ ] **Step 1: Implement**

Create `src/renderer/src/components/settings/pi/PiAdvancedAccordion.tsx`:

```tsx
import { useState } from 'react';
import type { PiSettings } from '../../../../../shared/pi-config-types';

type Props = {
  settings: PiSettings;
  onChange: (patch: Partial<PiSettings>) => Promise<void> | void;
  onOpenConfigFolder: () => Promise<void> | void;
};

export function PiAdvancedAccordion({
  settings,
  onChange,
  onOpenConfigFolder
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [cyclingDraft, setCyclingDraft] = useState((settings.enabledModels ?? []).join('\n'));

  const commitCycling = (): void => {
    const lines = cyclingDraft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    void onChange({ enabledModels: lines.length ? lines : undefined });
  };

  return (
    <section className="border-t border-neutral-800 pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm text-neutral-300 hover:text-neutral-100"
      >
        {open ? '▾' : '▸'} Advanced
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Theme</label>
            <input
              type="text"
              value={settings.theme ?? ''}
              onChange={(e) => void onChange({ theme: e.target.value || undefined })}
              placeholder="dark"
              className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-40"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Model cycling (Ctrl+P)</label>
            <textarea
              value={cyclingDraft}
              onChange={(e) => setCyclingDraft(e.target.value)}
              onBlur={commitCycling}
              rows={4}
              placeholder={'claude-*\ngpt-4o\ngemini-2*'}
              className="w-full bg-neutral-800 text-xs font-mono text-neutral-200 rounded px-2 py-1 border border-neutral-700"
            />
            <p className="text-xs text-neutral-500 mt-1">
              One pattern per line. Matches model ids or names.
            </p>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-neutral-400">
              Config folder: <code>~/.pi/agent/</code>
            </span>
            <button
              type="button"
              onClick={() => void onOpenConfigFolder()}
              className="text-xs px-2 py-1 rounded border border-neutral-700 hover:bg-neutral-800"
            >
              Open
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            Pi CLI writes the same files. If <code>pi</code> is open in a terminal, save from one
            side at a time.
          </p>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiAdvancedAccordion.tsx
git commit -m "feat(pi): PiAdvancedAccordion for theme/cycling/config-folder"
```

---

## Task 14: Trim `PiDefaultsForm` — drop theme + model cycling

**Files:**

- Modify: `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx` (remove the theme and model-cycling blocks; lines approximately 131-155)

- [ ] **Step 1: Remove theme + cycling fields**

Edit `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx`. Delete these two blocks entirely:

```tsx
      <div>
        <SettingRow label="Theme">
          <input
            type="text"
            value={settings.theme ?? ''}
            onChange={(e) => void onChange({ theme: e.target.value || undefined })}
            placeholder="dark"
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-40"
          />
        </SettingRow>
      </div>

      <div>
        <label className="text-sm text-neutral-300 block mb-1">Model cycling (Ctrl+P)</label>
        <textarea
          value={enabledModelsText}
          onChange={(e) => setEnabledModelsText(e.target.value)}
          onBlur={commitEnabledModels}
          rows={4}
          placeholder={'claude-*\ngpt-4o\ngemini-2*'}
          className="w-full bg-neutral-800 text-xs font-mono text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        <p className="text-xs text-neutral-500 mt-1">
          One pattern per line. Matches model ids or names.
        </p>
      </div>
```

Also delete the now-unused local state at the top of the component:

```tsx
  const [enabledModelsText, setEnabledModelsText] = useState(
    (settings.enabledModels ?? []).join('\n')
  );
  // ...
  const commitEnabledModels = (): void => { ... };
```

And remove the `useState` import if it becomes unused. Keep the `useMemo` import.

Update the subtitle. After the `<h2>` (currently `Defaults`), add:

```tsx
<p className="text-xs text-neutral-500 -mt-3 mb-1">
  Used when you open a new Pi tab without specifying otherwise.
</p>
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiDefaultsForm.tsx
git commit -m "refactor(pi): trim PiDefaultsForm to provider/model/thinking only"
```

---

## Task 15: `PiPresetPicker` — never show Bedrock card

**Files:**

- Modify: `src/renderer/src/components/settings/pi/PiPresetPicker.tsx`

- [ ] **Step 1: Filter out the Bedrock preset**

Edit `src/renderer/src/components/settings/pi/PiPresetPicker.tsx`. Find where it iterates over `PI_PRESETS` and filter:

```tsx
  {PI_PRESETS.filter((p) => p.id !== 'bedrock').map((preset) => (
    // existing card rendering
  ))}
```

Since Task 7 already removed Bedrock from `PI_PRESETS`, this filter is a belt-and-braces guard that keeps the file correct if someone ever re-adds a bedrock preset. If `PiPresetPicker` doesn't reference `bedrock` after Task 7 (no filter needed), this task is a no-op — skip to Step 2.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit (skip if no changes)**

```bash
git add src/renderer/src/components/settings/pi/PiPresetPicker.tsx
git commit -m "chore(pi): guard PiPresetPicker against Bedrock preset"
```

---

## Task 16: Wire the new top-level `PiSection`

**Files:**

- Modify: `src/renderer/src/components/settings/pi/PiSection.tsx` (full rewrite)

- [ ] **Step 1: Rewrite `PiSection`**

Replace the entire contents of `src/renderer/src/components/settings/pi/PiSection.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import type {
  PiSettings,
  PiModelsFile,
  BuiltInProviderStatus,
  ModelEntry
} from '../../../../../shared/pi-config-types';
import type { RedactedBedrock } from '../../../../../shared/pi-env-injection-types';
import {
  PI_BUILT_IN_PROVIDERS,
  getPreset,
  type PiPresetId
} from '../../../../../shared/pi-presets';
import { PiDefaultsForm } from './PiDefaultsForm';
import { PiProvidersList } from './PiProvidersList';
import { PiWelcomeStrip } from './PiWelcomeStrip';
import { PiAdvancedAccordion } from './PiAdvancedAccordion';

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      settings: PiSettings;
      models: PiModelsFile;
      builtIn: BuiltInProviderStatus[];
      bedrockEnv: RedactedBedrock | undefined;
    }
  | { kind: 'error'; message: string };

export function PiSection(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [modelCatalog, setModelCatalog] = useState<ModelEntry[]>([]);
  const [autoExpandId, setAutoExpandId] = useState<string | null>(null);

  useEffect(() => {
    void window.fleet.piConfig.listAvailableModels().then(setModelCatalog);
  }, []);

  const load = async (): Promise<void> => {
    try {
      const [settings, models, builtIn, bedrockEnv] = await Promise.all([
        window.fleet.piConfig.readSettings(),
        window.fleet.piConfig.readModels(),
        window.fleet.piConfig.getBuiltInStatus(),
        window.fleet.piEnv.readBedrock()
      ]);
      setState({ kind: 'ready', settings, models, builtIn, bedrockEnv });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    let alive = true;
    void load().then(() => {
      if (!alive) return;
    });
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const bedrockHasEnvConfig = useMemo(() => {
    if (state.kind !== 'ready' || !state.bedrockEnv) return false;
    const b = state.bedrockEnv;
    return Boolean(b.region || b.profile || b.accessKeyId || b.secretAccessKeyPresent);
  }, [state]);

  const configuredCount = useMemo(() => {
    if (state.kind !== 'ready') return 0;
    const builtInCount = state.builtIn.filter((s) => s.authenticated).length;
    const managedBedrockConfigured = bedrockHasEnvConfig ? 1 : 0;
    const bedrockAlreadyCountedFromBuiltIn = state.builtIn.find(
      (s) => s.id === 'bedrock' && s.authenticated
    )
      ? 1
      : 0;
    const customCount = Object.keys(state.models.providers).filter((id) => id !== 'bedrock').length;
    return (
      builtInCount +
      customCount +
      Math.max(0, managedBedrockConfigured - bedrockAlreadyCountedFromBuiltIn)
    );
  }, [state, bedrockHasEnvConfig]);

  if (state.kind === 'loading') {
    return <div className="text-sm text-neutral-400">Loading pi configuration…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded bg-red-900/30 border border-red-700/50 px-3 py-2 text-sm text-red-300">
        Failed to read pi config: {state.message}
        <button
          onClick={() => void window.fleet.piConfig.openConfigFolder()}
          className="ml-2 underline"
        >
          Open config folder
        </button>
      </div>
    );
  }

  const handleAddCustom = (presetId: PiPresetId): void => {
    // Pull defaults from the single source of truth (pi-presets.ts) and write a new provider
    // entry immediately. PiProvidersList auto-expands the new row so the user can edit it.
    const preset = getPreset(presetId);
    let id = preset.defaultProviderId;
    let i = 1;
    while (id in state.models.providers) id = `${preset.defaultProviderId}-${i++}`;
    void window.fleet.piConfig.writeProvider(id, { ...preset.defaults }).then(async () => {
      await load();
      setAutoExpandId(id);
    });
  };

  const handleLegacyMigrate = async (): Promise<void> => {
    // Keep modelOverrides/models as-is (they are already written through the new panel's
    // "Models" section via writeProvider) but strip the stray api/apiKey/baseUrl we used to add.
    const legacy = state.models.providers['bedrock'];
    if (!legacy) return;
    const next = { ...legacy };
    delete next.baseUrl;
    delete next.api;
    delete next.apiKey;
    delete next.compat;
    await window.fleet.piConfig.writeProvider('bedrock', next);
    await load();
  };

  const handleLegacyKeepAsCustom = (): void => {
    // Banner is session-dismissed inside PiBedrockPanel; parent has nothing to persist.
    // The legacy `providers.bedrock` entry stays intact until the user chooses to migrate.
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl text-neutral-100 font-semibold">Pi Agent</h1>
        <p className="text-sm text-neutral-500">
          Configure which models pi can use. Pi shares this config with your CLI.
        </p>
      </header>

      {configuredCount === 0 && (
        <PiWelcomeStrip
          onPick={(id) => setAutoExpandId(id)}
          onShowMore={() => setAutoExpandId(null)}
        />
      )}

      <PiProvidersList
        builtIn={state.builtIn}
        models={state.models}
        bedrockHasEnvConfig={bedrockHasEnvConfig}
        autoExpandId={autoExpandId}
        onExpandConsumed={() => setAutoExpandId(null)}
        onAddCustom={handleAddCustom}
        onSaveCustom={async (id, provider) => {
          await window.fleet.piConfig.writeProvider(id, provider);
          await load();
        }}
        onDeleteCustom={async (id) => {
          await window.fleet.piConfig.deleteProvider(id);
          await load();
        }}
        onLegacyMigrate={handleLegacyMigrate}
        onLegacyKeepAsCustom={handleLegacyKeepAsCustom}
      />

      <PiDefaultsForm
        settings={state.settings}
        models={state.models}
        modelCatalog={modelCatalog}
        builtInProviderIds={PI_BUILT_IN_PROVIDERS.map((p) => p.id)}
        onChange={async (patch) => {
          await window.fleet.piConfig.writeSettings(patch);
          await load();
        }}
      />

      <PiAdvancedAccordion
        settings={state.settings}
        onChange={async (patch) => {
          await window.fleet.piConfig.writeSettings(patch);
          await load();
        }}
        onOpenConfigFolder={async () => window.fleet.piConfig.openConfigFolder()}
      />
    </div>
  );
}
```

- [ ] **Step 2: Delete the now-unused `PiCustomProvidersList` import and file**

Delete `src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx` (no longer imported anywhere). If lint/typecheck reports it as unreferenced, confirm no other import survives, then remove:

```bash
git rm src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx
```

Also delete `src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx`:

```bash
git rm src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/pi/
git commit -m "feat(pi): new PiSection layout + retire old sub-lists"
```

---

## Task 17: Manual smoke test + verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the entire repo**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: All tests green. (If any pre-existing test fails unrelated to this work, raise it with the user before touching it.)

- [ ] **Step 4: Dev smoke — first-run / empty-state path**

Run: `npm run dev`

In the running app, open **Settings → Pi Agent** and verify:

1. If the user has no pi config yet (`~/.pi/agent/` empty), the **Welcome strip** appears above the Providers list.
2. Clicking the "Amazon Bedrock" welcome card scrolls to and expands the Bedrock row.
3. Providers list renders with the primary tier above "Show more providers".
4. **Defaults** shows only Default provider / Default model / Thinking level.
5. **Advanced** is collapsed by default; expanding reveals theme + model cycling + "Open config folder" + CLI concurrency note.

- [ ] **Step 5: Dev smoke — Bedrock configuration path**

With dev still running:

1. Expand Bedrock. Enter `AWS_REGION = us-east-1`. Blur — the dot on the row moves from grey to amber.
2. Pick "Use access keys". Enter an `Access Key ID` and a fake `Secret Access Key`, click Save. Field flips to `●●●●●●●● (set)`.
3. Open the DevTools and run `await window.fleet.piEnv.readBedrock()` — confirm `secretAccessKeyPresent: true` and **no plaintext secret** in the result.
4. Pick "Use credential chain". Only `AWS_REGION` is active.
5. Open a new Pi tab (`Cmd-N` or your usual spawn). In DevTools main process log (or by `console.log`-ing the returned `cmd` briefly during smoke), confirm the command starts with `AWS_REGION='us-east-1' FLEET_BRIDGE_PORT=…`.

- [ ] **Step 6: Dev smoke — legacy migration**

Manually add an old-style Bedrock custom provider to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "bedrock": {
      "api": "anthropic-messages",
      "models": [{ "id": "anthropic.claude-sonnet-4-5-20250929-v1:0" }]
    }
  }
}
```

Reopen Settings → Pi Agent → Bedrock. The **inline migration banner** should appear. Click "Move" and verify the banner dismisses. Click "Keep as custom" in a separate scenario and verify the `bedrock` row continues to render through the managed panel (legacy fields still present; banner stays until Move is clicked).

- [ ] **Step 7: Commit nothing (verification-only)**

No commit for this task.

---

## Task 18: Changelog entry

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a changelog entry**

Edit `CHANGELOG.md`. Above the most recent entry, add:

```markdown
## Unreleased

### Added

- Pi Agent settings page redesigned around a unified Providers list with a welcome strip for first-time users and an Advanced accordion for rarely-changed knobs.
- Amazon Bedrock now has a first-class configuration panel. AWS region, profile, access keys, and session token can be entered in Fleet; secrets are encrypted via the OS keychain (`safeStorage`) and injected into Pi tabs Fleet launches.

### Changed

- Removed the Bedrock "custom provider" preset from the Add-Provider picker. Existing `providers.bedrock` entries get a one-time inline migration prompt inside the new Bedrock panel.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for Pi settings redesign + Bedrock env injection"
```

---

## Summary

- Tasks 1–7 build the main-process foundation: schemas, shell-quote helper, the injection manager, IPC wiring, and preset cleanup. All TDD-covered.
- Task 8 extracts row-ordering as a pure function and unit-tests it.
- Tasks 9–13 build the renderer components (welcome strip, Bedrock panel, provider row, provider list, advanced accordion).
- Tasks 14–16 trim and rewire the existing renderer surfaces (PiDefaultsForm, PiPresetPicker, PiSection).
- Task 17 verifies the whole thing end-to-end with a manual smoke walkthrough including the legacy migration path.
- Task 18 lands a changelog entry.
