import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// ── installFleetCLI ───────────────────────────────────────────────────────────
//
// Ensures the `fleet` CLI binary is available at ~/.fleet/bin/fleet.
// The Admiral's Claude Code PTY needs this on its PATH to run `fleet` commands.
//
// Directory layout:
//   ~/.fleet/bin/fleet          — executable shell wrapper
//   ~/.fleet/lib/fleet-cli.js   — JS entrypoint (or symlink to compiled output)

export async function installFleetCLI(): Promise<string> {
  const fleetHome = join(homedir(), '.fleet')
  const binDir = join(fleetHome, 'bin')
  const libDir = join(fleetHome, 'lib')

  // 1. Create directories
  await mkdir(binDir, { recursive: true })
  await mkdir(libDir, { recursive: true })

  // 2. Determine the path to fleet-cli source/compiled output
  //    In dev mode: run fleet-cli.ts directly via tsx
  //    In packaged mode: the compiled .mjs lives next to index.mjs
  const isPackaged = existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs'))
    || existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.js'))

  let cliEntrypoint: string
  let wrapperContent: string

  if (isPackaged) {
    // Production: use the compiled output bundled alongside the app
    const compiledPath = existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs'))
      ? join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs')
      : join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.js')

    // Copy the compiled CLI to ~/.fleet/lib/fleet-cli.js
    const { readFile } = await import('node:fs/promises')
    const compiledSource = await readFile(compiledPath, 'utf8')
    cliEntrypoint = join(libDir, 'fleet-cli.js')
    await writeFile(cliEntrypoint, compiledSource, 'utf8')

    wrapperContent = `#!/bin/bash
# Fleet CLI — connects to running Fleet app via Unix socket
FLEET_DIR="$(dirname "$(dirname "$0")")"
exec node "$FLEET_DIR/lib/fleet-cli.js" "$@"
`
  } else {
    // Dev mode: resolve the TypeScript source file
    // import.meta.url points to the compiled .mjs in out/main/
    // The TS source lives at src/main/fleet-cli.ts relative to project root
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const tsSource = join(projectRoot, 'src', 'main', 'fleet-cli.ts')

    // Write a thin JS entrypoint that delegates to the TS source via tsx
    cliEntrypoint = join(libDir, 'fleet-cli.js')
    const jsEntrypoint = `#!/usr/bin/env node
// Fleet CLI entrypoint — dev mode, delegates to TypeScript source via tsx
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Find tsx in the project's node_modules
const tsSource = ${JSON.stringify(tsSource)};
const projectRoot = ${JSON.stringify(projectRoot)};
const tsx = join(projectRoot, 'node_modules', '.bin', 'tsx');

const result = spawnSync(tsx, [tsSource, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(result.status ?? 1);
`
    await writeFile(cliEntrypoint, jsEntrypoint, 'utf8')

    wrapperContent = `#!/bin/bash
# Fleet CLI — connects to running Fleet app via Unix socket
FLEET_DIR="$(dirname "$(dirname "$0")")"
exec node "$FLEET_DIR/lib/fleet-cli.js" "$@"
`
  }

  // 3. Write the shell wrapper
  const wrapperPath = join(binDir, 'fleet')
  await writeFile(wrapperPath, wrapperContent, 'utf8')

  // 4. Make the shell wrapper executable (chmod 755)
  await chmod(wrapperPath, 0o755)

  console.log(`[fleet-cli] Installed fleet CLI at ${wrapperPath}`)

  return binDir
}
