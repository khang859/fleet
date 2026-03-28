import { mkdir, writeFile, chmod, readFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { createLogger } from './logger';
const log = createLogger('fleet-cli');

// ── installFleetCLI ───────────────────────────────────────────────────────────
//
// Ensures the `fleet` CLI binary is available at ~/.fleet/bin/fleet.
// The Admiral's Claude Code PTY needs this on its PATH to run `fleet` commands.
//
// Directory layout:
//   ~/.fleet/bin/fleet          — executable shell wrapper
//   ~/.fleet/lib/fleet-cli.js   — JS entrypoint (or symlink to compiled output)

export async function installFleetCLI(): Promise<string> {
  const fleetHome = join(homedir(), '.fleet');
  const binDir = join(fleetHome, 'bin');
  const libDir = join(fleetHome, 'lib');

  // 1. Create directories
  await mkdir(binDir, { recursive: true });
  await mkdir(libDir, { recursive: true });

  // 2. Determine the path to fleet-cli source/compiled output
  //    In dev mode: run fleet-cli.ts directly via tsx
  //    In packaged mode: the compiled .mjs lives next to index.mjs
  const isPackaged =
    existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs')) ||
    existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.js'));

  let cliEntrypoint: string;
  let wrapperContent: string;

  // Shell wrapper with node path detection for common version managers.
  // Non-interactive shells (e.g. Claude Code) don't source ~/.zshrc or nvm.sh,
  // so `node` may not be on PATH. This wrapper probes nvm, fnm, volta, and
  // Homebrew before falling back to a helpful error message.
  const nodeResolverScript = `
# ── Node.js path resolution ───────────────────────────────────────────────────
# Only run if node isn't already accessible — don't override a working setup.
if ! command -v node >/dev/null 2>&1; then
  # nvm: use the default alias if available, otherwise pick the latest installed
  if [ -s "$HOME/.nvm/alias/default" ]; then
    NVM_DEFAULT="$(cat "$HOME/.nvm/alias/default")"
    NVM_BIN="$HOME/.nvm/versions/node/$NVM_DEFAULT/bin"
    [ -d "$NVM_BIN" ] && export PATH="$NVM_BIN:$PATH"
  fi
  if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
    NVM_LATEST="$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)"
    [ -n "$NVM_LATEST" ] && export PATH="$HOME/.nvm/versions/node/$NVM_LATEST/bin:$PATH"
  fi
  # fnm: default alias (respects $FNM_DIR override)
  if ! command -v node >/dev/null 2>&1; then
    FNM_DIR_RESOLVED="\${FNM_DIR:-$HOME/.local/share/fnm}"
    FNM_BIN="$FNM_DIR_RESOLVED/aliases/default/bin"
    [ -d "$FNM_BIN" ] && export PATH="$FNM_BIN:$PATH"
  fi
  # volta
  if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.volta/bin" ]; then
    export PATH="$HOME/.volta/bin:$PATH"
  fi
  # Homebrew — Apple Silicon first, then Intel/Linux
  if ! command -v node >/dev/null 2>&1 && [ -d "/opt/homebrew/bin" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  fi
  if ! command -v node >/dev/null 2>&1 && [ -d "/usr/local/bin" ]; then
    export PATH="/usr/local/bin:$PATH"
  fi
fi

# If node still can't be found, print a clear error and exit
if ! command -v node >/dev/null 2>&1; then
  echo "fleet: error: 'node' not found on PATH." >&2
  echo "       Fleet requires Node.js to run the CLI." >&2
  echo "       Install it via https://nodejs.org, nvm, fnm, or volta," >&2
  echo "       then restart Fleet so it can pick up the new installation." >&2
  exit 1
fi
`;

  if (isPackaged) {
    // Production: use the compiled output bundled alongside the app
    const compiledPath = existsSync(join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs'))
      ? join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.mjs')
      : join(dirname(fileURLToPath(import.meta.url)), 'fleet-cli.js');

    // Copy the compiled CLI to ~/.fleet/lib/fleet-cli.mjs
    // Must use .mjs extension so Node loads it as ESM (it contains import statements)
    const { readFile } = await import('node:fs/promises');
    const compiledSource = await readFile(compiledPath, 'utf8');
    cliEntrypoint = join(libDir, 'fleet-cli.mjs');
    await writeFile(cliEntrypoint, compiledSource, 'utf8');

    wrapperContent = `#!/bin/bash
# Fleet CLI — connects to running Fleet app via Unix socket
${nodeResolverScript}
FLEET_DIR="$(dirname "$(dirname "$0")")"
exec node "$FLEET_DIR/lib/fleet-cli.mjs" "$@"
`;
  } else {
    // Dev mode: resolve the TypeScript source file
    // import.meta.url points to the compiled .mjs in out/main/
    // The TS source lives at src/main/fleet-cli.ts relative to project root
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const tsSource = join(projectRoot, 'src', 'main', 'fleet-cli.ts');

    // Write a thin JS entrypoint that delegates to the TS source via tsx
    // Must use .mjs extension so Node loads it as ESM (it contains import statements)
    cliEntrypoint = join(libDir, 'fleet-cli.mjs');
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
`;
    await writeFile(cliEntrypoint, jsEntrypoint, 'utf8');

    wrapperContent = `#!/bin/bash
# Fleet CLI — connects to running Fleet app via Unix socket
${nodeResolverScript}
FLEET_DIR="$(dirname "$(dirname "$0")")"
exec node "$FLEET_DIR/lib/fleet-cli.mjs" "$@"
`;
  }

  // 3. Write the shell wrapper
  const wrapperPath = join(binDir, 'fleet');
  await writeFile(wrapperPath, wrapperContent, 'utf8');

  // 4. Make the shell wrapper executable (chmod 755)
  await chmod(wrapperPath, 0o755);

  // 5. Add ~/.fleet/bin to user's shell profile (idempotent)
  await addFleetBinToShellProfile().catch((err) => {
    log.warn('could not update shell profile', {
      error: err instanceof Error ? err.message : String(err)
    });
  });

  log.info('installed fleet CLI', { path: wrapperPath });

  return binDir;
}

// ── installSkillFile ─────────────────────────────────────────────────────────
//
// Copies the Fleet skill file to ~/.fleet/skills/fleet.md so AI agents
// running in Fleet terminals can read it and learn available commands.
// Overwrites on every launch to stay in sync with the app version.

export async function installSkillFile(): Promise<void> {
  const fleetHome = join(homedir(), '.fleet');
  const skillsDir = join(fleetHome, 'skills');

  await mkdir(skillsDir, { recursive: true });

  // Locate the source skill file
  const mainDir = dirname(fileURLToPath(import.meta.url));

  const candidatePaths = [
    // Dev mode: project root / resources / skills / fleet.md
    join(mainDir, '..', '..', 'resources', 'skills', 'fleet.md'),
    // Packaged mode (asar unpacked): process.resourcesPath
    join(process.resourcesPath ?? '', 'app.asar.unpacked', 'resources', 'skills', 'fleet.md')
  ];

  let sourceContent: string | null = null;
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      sourceContent = await readFile(candidate, 'utf8');
      break;
    }
  }

  if (!sourceContent) {
    log.warn('skill file source not found, skipping install', {
      candidates: candidatePaths
    });
    return;
  }

  const destPath = join(skillsDir, 'fleet.md');
  await writeFile(destPath, sourceContent, 'utf8');
  log.info('installed fleet skill file', { path: destPath });
}

// ── addFleetBinToShellProfile ─────────────────────────────────────────────────
//
// Appends `export PATH="$HOME/.fleet/bin:$PATH"` to every common shell profile
// that already exists on disk — similar to how nvm and Homebrew inject themselves.
// Idempotent: skips any file that already mentions `.fleet/bin`.
// No-op on Windows (PATH is managed differently there).

async function addFleetBinToShellProfile(): Promise<void> {
  if (process.platform === 'win32') return;

  const home = homedir();

  // Candidate profile files, grouped by syntax.
  const posixProfiles = [
    join(home, '.zshrc'),
    join(home, '.zprofile'),
    join(home, '.bash_profile'),
    join(home, '.bashrc'),
    join(home, '.profile')
  ];
  const fishProfiles = [join(home, '.config', 'fish', 'config.fish')];

  const posixExport = '\n# Fleet CLI\nexport PATH="$HOME/.fleet/bin:$PATH"\n';
  const fishExport = '\n# Fleet CLI\nfish_add_path $HOME/.fleet/bin\n';

  const profilesWithContent: Array<{ path: string; content: string }> = [
    ...posixProfiles.map((p) => ({ path: p, content: posixExport })),
    ...fishProfiles.map((p) => ({ path: p, content: fishExport }))
  ];

  for (const { path: profilePath, content } of profilesWithContent) {
    if (!existsSync(profilePath)) continue;

    const existing = await readFile(profilePath, 'utf8').catch(() => '');
    if (existing.includes('.fleet/bin')) continue;

    await appendFile(profilePath, content, 'utf8');
    log.info('added ~/.fleet/bin to shell profile', { profilePath });
  }
}
