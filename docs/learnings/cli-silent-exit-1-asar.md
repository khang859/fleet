# Fleet CLI: Silent Exit 1 — Root Cause & Fix

## Symptom

Running `fleet <command>` exits with code 1 and no output, even when `node` is available.

## Root Cause: Chain of Failures

### 1. `fleet-cli.mjs` is never built as a separate file

`electron.vite.config.ts` compiles the Electron main process into a single `out/main/index.mjs`. There is no separate entry point for `src/main/fleet-cli.ts`, so `fleet-cli.mjs` never appears in `out/main/`.

### 2. `isPackaged` detection is always `false` in the packaged app

`install-fleet-cli.ts` determines whether it's running in a packaged app by checking:

```typescript
const isPackaged =
  existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs')) ||
  existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.js'));
```

Since `fleet-cli.mjs` is never built, this is **always `false`** — even inside the packaged Electron app.

### 3. Dev-mode path embeds asar-internal paths

Because `isPackaged` is `false`, the packaged app takes the "dev mode" install path. It writes a `~/.fleet/lib/fleet-cli.js` shim with hardcoded paths like:

```javascript
const tsSource = '/Applications/Fleet.app/Contents/Resources/app.asar/src/main/fleet-cli.ts';
const tsx = '/Applications/Fleet.app/Contents/Resources/app.asar/node_modules/.bin/tsx';
```

These paths are **inside the `.asar` archive**.

### 4. Regular `node` cannot access asar-internal paths

Electron patches its internal `fs` module to transparently read from `.asar` archives. But when `node ~/.fleet/lib/fleet-cli.js` runs **outside Electron**, no such patches are active. The asar file is treated as a regular file (not a directory). Attempting to access a path inside it returns `ENOTDIR`.

### 5. `spawnSync` fails silently → exit 1

```javascript
const result = spawnSync(tsx, [tsSource, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
});
process.exit(result.status ?? 1);
```

`spawnSync` fails with `ENOTDIR` and returns `{ status: null, error: ... }`. Since `stdio: 'inherit'` is set but the child never starts, **no output is produced**. `result.status ?? 1` evaluates to `1`. Silent exit 1.

## Verification

```bash
# Confirm: tsx inside asar is inaccessible to regular node
node -e "
const { spawnSync } = require('child_process');
const tsx = '/Applications/Fleet.app/Contents/Resources/app.asar/node_modules/.bin/tsx';
const result = spawnSync(tsx, ['--version'], { stdio: 'inherit' });
console.error('status:', result.status, 'error:', result.error?.message);
process.exit(result.status ?? 1);
"
# Output: status: null error: spawnSync ... ENOTDIR
# EXIT: 1
```

## Fix

### Add `fleet-cli.ts` as a separate Rollup entry in `electron.vite.config.ts`:

```typescript
main: {
  build: {
    rollupOptions: {
      input: {
        index: resolve('src/main/index.ts'),
        'fleet-cli': resolve('src/main/fleet-cli.ts'),
      },
      output: { format: 'es' }
    }
  }
}
```

This produces `out/main/fleet-cli.mjs` alongside `index.mjs`, making the `isPackaged` check work correctly.

### Update the wrapper to use `.mjs` extension (clearer ESM intent):

In `install-fleet-cli.ts`, when writing `cliEntrypoint`, save it as `fleet-cli.mjs` (not `.js`), and update the wrapper:

```bash
exec node "$FLEET_DIR/lib/fleet-cli.mjs" "$@"
```

### Alternative: Use `app.isPackaged` from Electron

Replace the file-existence check with Electron's authoritative API:

```typescript
import { app } from 'electron';
const isPackaged = app.isPackaged;
```

Then in the packaged path, use `app.getAppPath()` to get the Electron-aware path to the asar contents (readable inside Electron's process).

## Architecture Note

The CLI requires the Fleet desktop app to be running — it communicates via `~/.fleet/fleet.sock` (a Unix socket created by the running app). Without the app running, the CLI will get `ENOENT` on the socket and print:

```
Error: connect ENOENT ~/.fleet/fleet.sock (ENOENT)
```

This is expected behavior. The CLI is a **thin client** that delegates all logic to the running Fleet desktop app via the socket. Making the CLI work without the app would require a separate standalone mode not currently implemented.
