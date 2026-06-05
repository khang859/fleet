# S3 Env Sync — Design Spec

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Goal:** Let a developer sync a project's `.env` secrets to/from an S3 bucket, encrypted client-side, so the same secrets are available on multiple machines for local dev.

---

## 1. Summary

When you open a project in Fleet, it reads a committed, secret-free `.fleet/env-sync.json` pointer file. Using that config, Fleet can **pull** encrypted `.env` payloads from S3 (decrypt with a passphrase, write the `.env` file and/or inject vars into terminals) and **push** local changes back up. Sync is bidirectional with ETag-based conflict detection and a diff-prompt resolution UX.

**Locked decisions:**

| Decision | Choice |
|---|---|
| Project identity | Explicit per-repo `id` in committed `.fleet/env-sync.json` (Infisical/dotenv-vault pattern) |
| Multiple `.env` (monorepo) | Explicit `targets[]` list + a gitignore-aware "Scan" helper that proposes targets |
| Nested/multiple repos | Resolve by walking **up** from a `cwd` to the nearest `.fleet/env-sync.json` (SOPS pattern) |
| Bucket scope | Per-repo (repo-level default; per-target override allowed) |
| AWS auth | Per-repo selectable mode: **default chain** / **named profile** / **static keys**; global default + per-repo override. Profile name & static keys live in the local keychain store, never in committed config. Default mode stores no AWS keys. |
| At-rest protection | Client-side **AES-256-GCM + scrypt** passphrase encryption; bucket only holds ciphertext |
| Passphrase scope | Global default + optional per-repo override; stored in OS keychain via `safeStorage` |
| Sync model | Full bidirectional; ETag-based conflict detection; diff prompt (keep-local / keep-remote / cancel) |
| On project open | Background status check → status badge; **no surprise writes**; sync is explicit |
| Delivery | Per-target: write a real `.env` file **or** inject into Fleet terminals; default = file |
| Target `.env` path | Configurable per target (e.g. `apps/web/.env.production`) |
| UI placement | Settings "Env Sync" section + workspace status badge + conflict diff dialog (Approach C) |

---

## 2. The committed config — `.fleet/env-sync.json`

Lives at the repo root, **committed to git, contains no secrets** (only an identity + S3 addressing). Read by Fleet on project open.

```jsonc
{
  "version": 1,
  "id": "my-app",            // stable repo identity → passphrase-override key + objectKey namespace
  "bucket": "my-secrets",    // repo-level default; a target may override bucket/region
  "region": "us-east-1",
  "targets": [
    { "envFile": ".env",                  "delivery": "file" },
    { "envFile": "apps/web/.env.production", "delivery": "file" },
    { "envFile": "apps/api/.env",            "delivery": "inject", "objectKey": "custom/api.env.enc", "bucket": "other-bucket" }
  ]
}
```

**Target fields:**
- `envFile` (required): path to the env file, **relative to the repo root**.
- `delivery` (optional, default `"file"`): `"file"` writes the file on pull; `"inject"` injects vars into Fleet-spawned terminals whose `cwd` is within the target's directory.
- `objectKey` (optional): S3 object key. **Default** = `${id}/${envFile}.enc` (path-preserving, collision-free across apps/environments).
- `bucket` / `region` (optional): override the repo-level default.

**Single-`.env` project** is just `targets: [{ "envFile": ".env" }]` — same code path, no special case.

**Zod schema** (`src/shared/env-sync-types.ts`) validates this on read; invalid files surface a clear error in the status badge rather than throwing.

---

## 3. Local-only state — not committed

### 3a. Sync state (`fleet-env-sync-state.json`, electron-store)

Per-target last-synced fingerprint, used for conflict detection. Keyed by `${configPath}::${objectKey}` (absolute config path keeps repos with the same `id` on different machines/checkouts distinct locally).

```jsonc
{
  "/Users/me/dev/my-app/.fleet/env-sync.json::my-app/.env.enc": {
    "lastEtag": "\"d41d8cd9...\"",
    "lastPlaintextHash": "sha256-of-last-synced-plaintext",
    "lastSyncedAt": 1730000000
  }
}
```

### 3b. Passphrases + AWS auth (`fleet-env-sync-secrets.json`, electron-store + `safeStorage`)

Mirrors `PiEnvInjectionManager` exactly. Secrets encrypted with `safeStorage`, stored base64; never sent to the renderer in plaintext. Holds two parallel global-default + per-repo-override structures: one for the encryption passphrase, one for AWS auth.

```jsonc
{
  "globalPassphraseEnc": "base64...",          // optional global default
  "repoOverrides": {                            // keyed by repo id
    "my-app": { "passphraseEnc": "base64..." }
  },

  "globalAuth": {                               // optional global default AWS auth
    "mode": "profile",                          // 'default-chain' | 'profile' | 'static'
    "profile": "work",                          // for 'profile' mode (NOT secret, but machine-specific → local only)
    "accessKeyIdEnc": "base64...",              // for 'static' mode (safeStorage-encrypted)
    "secretAccessKeyEnc": "base64...",          // for 'static' mode
    "sessionTokenEnc": "base64..."              // optional, for 'static' mode
  },
  "authRepoOverrides": {                         // keyed by repo id
    "my-app": { "mode": "static", "accessKeyIdEnc": "...", "secretAccessKeyEnc": "..." }
  }
}
```

**Passphrase resolution** for a repo: `repoOverrides[id].passphraseEnc` → `globalPassphraseEnc` → error ("no passphrase configured").

**AWS auth resolution** for a repo: `authRepoOverrides[id]` → `globalAuth` → implicit `{ mode: 'default-chain' }`. The resolved entry maps to an AWS credentials provider:
- `default-chain` → `fromNodeProviderChain()`
- `profile` → `fromNodeProviderChain({ profile })`  *(covers ini / SSO / process credentials)*
- `static` → `{ accessKeyId, secretAccessKey, sessionToken? }` (decrypted from keychain on use)

The auth mode (and profile name) are **machine-specific** and never written to the committed `.fleet/env-sync.json` — only `bucket`/`region`/`targets`/`id` are shared.

---

## 4. Main-process module — `src/main/env-sync/`

Six focused units, each independently testable.

### `env-sync-config.ts`
- `EnvSyncConfigSchema` (zod) + `readConfig(repoDir): EnvSyncConfig | null`, `writeConfig(repoDir, config)`.
- `resolveTargetObjectKey(config, target)`, `resolveTargetBucketRegion(config, target)`.
- `findNearestConfig(cwd): { repoDir, config } | null` — walks **up** from `cwd` to filesystem root, returns the first dir containing `.fleet/env-sync.json`. Cached per-dir; cache invalidated on `writeConfig`.

### `env-sync-crypto.ts`
- `encrypt(plaintext: Buffer, passphrase: string): Buffer`
- `decrypt(blob: Buffer, passphrase: string): Buffer` (throws on auth failure / wrong passphrase)
- Scheme (research-validated, Node built-in `crypto`, no native deps):
  - **Cipher:** AES-256-GCM, fresh 12-byte random IV per encryption, 16-byte auth tag.
  - **KDF:** scrypt, **N=2¹⁷, r=8, p=1, dkLen=32**, fresh 16-byte random salt per encryption. **`maxmem: 256 * 1024 * 1024` is mandatory** — Node's default 32 MiB throws "memory limit exceeded" at these params.
  - **Envelope:** `version(1) || salt(16) || [log2N, r, p](3) || iv(12) || tag(16) || ciphertext`. Version byte enables future migration; params stored inline so cost can be raised without breaking old objects. `version||params` fed as AAD.
- Whole-file encryption (not per-key) — the stored object is opaque ciphertext; readable diffs are produced locally in the conflict UI (§7), not from the S3 object.

### `env-sync-secrets.ts`
- `getRedactedSecrets()` — redacted view of both passphrase and auth state:
  - passphrase: `{ globalPresent: boolean; repoOverrides: Record<string, { present: boolean }> }`
  - auth: `globalAuth?: { mode; profile?; hasAccessKeyId: boolean; hasSecretAccessKey: boolean; hasSessionToken: boolean }` and the same shape per repo under `authRepoOverrides`. Static-key material is **never** returned — only presence booleans + the non-secret `mode`/`profile`.
- `setGlobalPassphrase(plaintext)` / `clearGlobalPassphrase()`
- `setRepoPassphrase(id, plaintext)` / `clearRepoPassphrase(id)`
- `resolvePassphrase(id): string` (throws if none)
- `setGlobalAuth(config)` / `clearGlobalAuth()` — `config` is `{ mode, profile?, accessKeyId?, secretAccessKey?, sessionToken? }`; key material is `safeStorage`-encrypted before persisting.
- `setRepoAuth(id, config)` / `clearRepoAuth(id)`
- `resolveAuth(id): { mode; profile?; accessKeyId?; secretAccessKey?; sessionToken? }` — per-repo override → global → `{ mode: 'default-chain' }`; decrypts static keys on use.
- `isEncryptionAvailable(): boolean` — gates the UI (and is required before `static` auth can be saved). On Linux additionally warns if `safeStorage.getSelectedStorageBackend() === 'basic_text'` (no real protection).
- Uses `safeStorage` async API where practical to avoid main-thread blocking.

### `s3-client.ts`
- Thin `@aws-sdk/client-s3` wrapper. Each call takes a resolved `EnvSyncAuthResolved` (`{ mode, profile?, accessKeyId?, secretAccessKey?, sessionToken? }`); the client is cached per `(region, authFingerprint)` where `authFingerprint` = `mode` + `profile` + a hash of the static keys (so distinct identities don't share a client, and rotating keys invalidates the cache).
- `head(bucket, region, key, auth): { etag } | null` (null on 404).
- `get(bucket, region, key, auth): { body: Buffer; etag }`.
- `put(bucket, region, key, body, auth, ifMatch?): { etag }` — uses `If-Match` for safe overwrite; on `PreconditionFailed` the manager treats it as a conflict. New objects use `If-None-Match: *`.
- Credential resolution from `auth`: `default-chain` → `fromNodeProviderChain()`; `profile` → `fromNodeProviderChain({ profile })`; `static` → static credentials object. Clear error if the chain yields nothing.

### `env-file.ts`
- `parseEnv(text): { entries: Array<{key, value, raw}>; map: Record<string,string> }` — minimal parser preserving order/comments for round-tripping; tolerant of `export`, quotes, `#` comments.
- `serializeEnv(...)` — writes back, preserving untouched lines where possible.
- `diff(localText, remoteText): EnvDiff` — per-key `added | removed | changed | unchanged`, with **values masked** (e.g. `changed`, last 2 chars hint) for the conflict UI.
- `hashPlaintext(text): string` — sha256 for conflict detection.
- `scanCandidates(repoDir): string[]` — for the Scan helper: lists candidate env files honoring `.gitignore`, **excluding** `.env.example/.sample/.template/.dist`, `node_modules/`, `.git/`, build dirs (`dist`, `build`, `.next`, `.turbo`, `out`, `coverage`). Candidate includes: `.env`, `.env.local`, `.env.<env>`, `.env.<env>.local`.

### `env-sync-manager.ts` (orchestrator)
Owns the sync-state store; depends on the five units above + `env-sync-secrets`. Before any S3 call it resolves the repo's AWS auth via `secrets.resolveAuth(config.id)` and passes the resolved object into every `s3-client` call (alongside the passphrase it already resolves).

- `status(repoDir): TargetStatus[]` — per target: `head` remote ETag, compare against local state + current local file hash → derive:
  - `remoteChanged = remoteEtag !== state.lastEtag`
  - `localChanged  = hashPlaintext(localFile) !== state.lastPlaintextHash` (local file missing ⇒ treated as no-local)
  - both → **conflict**; remote only → **remote-ahead**; local only → **local-ahead**; neither → **in-sync**; no remote object → **local-only**; no local + remote exists → **remote-only**.
- `pull(repoDir, target, { force }): PullResult` — `get` → `decrypt` → if `localChanged && !force` and remote also changed → return `{ conflict, diff }`; else apply: `file` delivery writes `envFile`; `inject` delivery updates the in-memory injection cache; update local state.
- `push(repoDir, target, { force }): PushResult` — read local `envFile` → `encrypt` → `put` with `If-Match: lastEtag` (omit / `If-None-Match:*` when no remote). `PreconditionFailed` → `{ conflict, diff }` unless `force`. Update local state.
- `resolveConflict(repoDir, target, choice)` — `keep-local` → `push({force:true})`; `keep-remote` → `pull({force:true})`.
- `getEnvForCwd(cwd): Record<string,string>` — for **inject** delivery at PTY spawn: `findNearestConfig(cwd)` → among `inject` targets, pick the one whose `envFile` directory is the **longest prefix** of `cwd` (most-specific wins) → return decrypted vars from the injection cache (decrypting on first use, then cached in memory keyed by objectKey+etag). Returns `{}` when nothing applies or passphrase is locked.

---

## 5. Delivery integration

### File delivery
On `pull`, write the decrypted content to `<repoDir>/<envFile>`. If the file isn't gitignored, surface a non-blocking warning in the UI (offer to append the path to `.gitignore`). v1: warning only; no automatic edits.

### Inject delivery
Hook into the existing `PTY_CREATE` handler (`src/main/ipc-handlers.ts:121`). Today it builds `extraEnv` (CLAUDE_CONFIG_DIR). We add:

```ts
const injected = envSyncManager.getEnvForCwd(req.cwd);
Object.assign(extraEnv, injected); // injected wins for collisions, like CLAUDE_CONFIG_DIR
```

The existing spread `{ ...process.env, ...extraEnv }` already delivers these to the spawned shell. Inject vars are decrypted once and cached in memory (keyed by objectKey + etag), so spawns stay fast. Inject only affects Fleet-spawned shells — it never writes to disk.

---

## 6. IPC surface

Channels in `src/shared/ipc-channels.ts`, types in `src/shared/ipc-api.ts` (or a dedicated `env-sync-types.ts`), preload wrappers under `window.fleet.envSync.*`, handlers in `ipc-handlers.ts`.

| Channel | Purpose |
|---|---|
| `ENV_SYNC_GET_CONFIG` | Read `.fleet/env-sync.json` for a repoDir (or resolve nearest for a cwd) |
| `ENV_SYNC_WRITE_CONFIG` | Create/update the config file (used by the settings UI + Scan) |
| `ENV_SYNC_SCAN` | Return candidate env files for a repoDir (Scan helper) |
| `ENV_SYNC_STATUS` | Per-target status for a repoDir |
| `ENV_SYNC_PULL` / `ENV_SYNC_PUSH` | Pull/push a target; may return `{ conflict, diff }` |
| `ENV_SYNC_RESOLVE` | Resolve a conflict (`keep-local` / `keep-remote`) |
| `ENV_SYNC_DIFF` | Compute masked local-vs-remote diff for a target |
| `ENV_SYNC_GET_SECRETS` | Redacted passphrase + auth state (global + per-repo) |
| `ENV_SYNC_SET_PASSPHRASE` / `ENV_SYNC_CLEAR_PASSPHRASE` | Manage global / per-repo passphrase |
| `ENV_SYNC_SET_AUTH` / `ENV_SYNC_CLEAR_AUTH` | Manage global / per-repo AWS auth (mode + profile + static keys) |
| `ENV_SYNC_ENCRYPTION_AVAILABLE` | Gate UI on `safeStorage` availability |

Passphrases and static AWS keys cross the boundary as plaintext only inbound on set; outbound is always redacted (presence flags + non-secret `mode`/`profile`), following the PiEnvInjection pattern. The set-auth request distinguishes global vs per-repo by an optional `id` (PiEnvInjection set-pattern).

---

## 7. Renderer UI (Approach C)

### Settings → new "Env Sync" section
Registered in `SettingsNav.tsx` (`SettingsSection` union + `ALL_SECTIONS`) and `SettingsTab.tsx` (`SECTION_COMPONENTS`). Built with existing `SettingRow` + plain controlled inputs (no form lib), `useToastStore` for feedback — matching `CopilotSection`.

- **Encryption gate:** if `safeStorage` unavailable (or Linux `basic_text`), show a warning and disable secret entry (passphrase **and** static-key auth).
- **Global passphrase:** masked entry following `PiBedrockPanel` (redacted "●●●● (set)" + Clear/Replace; password draft + Save when unset).
- **Global AWS auth:** a mode dropdown (`Default credential chain` / `Named profile` / `Static keys`). `profile` mode shows a plain text profile-name input; `static` mode shows masked access-key-id / secret-access-key / optional session-token inputs (redacted "●●●● (set)" + Clear/Replace when set). Static mode is disabled when encryption is unavailable.
- **Per-repo accordion** (copilot `workspaceOverrides` pattern): one row per repo discovered from open workspace tab `cwd`s (resolve nearest config, dedup by config path). Each expanded row shows:
  - Repo `id`, bucket/region (editable → `ENV_SYNC_WRITE_CONFIG`).
  - **Targets table:** per target — env file path, delivery dropdown (`file`/`inject`), status badge, **Pull** / **Push** buttons.
  - **Scan** button → lists candidates (`ENV_SYNC_SCAN`) with checkboxes → adds selected as targets.
  - Optional per-repo passphrase override (Clear/Replace).
  - Optional per-repo AWS auth override (same mode dropdown + inputs as the global control); "Use global default" clears the override.
- Async actions show inline progress + success/error toasts.

### Workspace status badge + conflict dialog
- A small **badge** in the workspace chrome (near the tab bar) reflects the aggregate status of the active tab's resolved repo: in-sync / remote-ahead / local-ahead / conflict / locked (no passphrase). Computed on project open via background `ENV_SYNC_STATUS` (no writes).
- Clicking the badge (or a conflicting Pull/Push) opens a **conflict diff dialog**: masked per-key diff (added/removed/changed) with **Keep Local**, **Keep Remote**, **Cancel** → `ENV_SYNC_RESOLVE`.

---

## 8. Dependencies

Add: `@aws-sdk/client-s3`, `@aws-sdk/credential-providers`. Use Node built-in `crypto` (no native crypto dep) and a small custom `.env` parser (no `dotenv` dep, so we preserve order/comments for round-trip + masked diffs).

---

## 9. Out of scope (v1 / YAGNI)

- Layering a shared/common secret set under app-specific (Infisical `--path A --path B`). Note for later.
- Asymmetric / multi-recipient encryption for team sharing (age/dotenvx). Revisit if team sharing is needed; would adopt age's X25519 + ChaCha20-Poly1305, not dotenvx's secp256k1.
- Auto-pull on open and auto-push on file change (explicit, manual sync only in v1).
- Per-environment selection logic tied to NODE_ENV (each env file is just its own target).
- Secret rotation / versioned history beyond S3's own object versioning.

---

## 10. Testing strategy

- **`env-sync-crypto`:** round-trip encrypt→decrypt; wrong passphrase rejects; tamper (flip a byte) rejects; envelope version/param parsing; confirm `maxmem` is set (no throw at N=2¹⁷).
- **`env-file`:** parse/serialize round-trip (comments, quotes, `export`); diff add/remove/change with masking; `scanCandidates` excludes templates/node_modules and honors gitignore.
- **`env-sync-config`:** schema validation; `objectKey` defaulting; `findNearestConfig` walk-up incl. nested repos + cache invalidation; most-specific target selection for a cwd.
- **`env-sync-manager`:** status derivation matrix (in-sync / *-ahead / conflict / *-only) with mocked `s3-client`; pull/push conflict paths; `If-Match` precondition → conflict; `getEnvForCwd` resolution.
- **`env-sync-secrets`:** passphrase resolution order; redaction never leaks plaintext (mock `safeStorage`, mirror existing PiEnvInjection tests); AWS auth resolution order (per-repo → global → `default-chain`); redacted auth view exposes `mode`/`profile` + presence booleans but never key material; static keys round-trip through `safeStorage`.
- **`s3-client`:** auth fingerprint differs per `(region, mode, profile, static-key-hash)` so distinct identities get distinct cached clients; `default-chain`/`profile`/`static` each build the expected credentials provider (with the AWS SDK calls stubbed).
- **Integration:** `PTY_CREATE` injects vars for an `inject` target when cwd is within its directory.

---

## 11. Build sequence

1. Types + zod schemas (`src/shared/env-sync-types.ts`) + IPC channel/type stubs.
2. `env-sync-crypto` + tests (pure, no I/O — establishes the security core first).
3. `env-file` (parse/serialize/diff/scan) + tests.
4. `env-sync-config` (read/write/resolve/walk-up) + tests.
5. `env-sync-secrets` (keychain) + tests.
6. `s3-client` (AWS SDK wrapper).
7. `env-sync-manager` (orchestration) + tests with mocked s3/crypto.
8. IPC handlers + preload wrappers.
9. `PTY_CREATE` inject integration.
10. Settings "Env Sync" section UI.
11. Workspace status badge + conflict diff dialog.
12. End-to-end manual verification against a real bucket; typecheck + lint + test.
