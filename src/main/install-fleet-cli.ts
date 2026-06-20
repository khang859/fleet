import {
  mkdir,
  writeFile,
  chmod,
  readFile,
  appendFile,
  copyFile,
  readdir,
  rm
} from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { createLogger } from './logger';
const log = createLogger('fleet-cli');

async function copyDirectoryRecursive(sourceDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destPath);
      continue;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, destPath);
    }
  }
}

async function installBundledCliArtifacts(compiledPath: string, libDir: string): Promise<string> {
  const cliEntrypoint = join(libDir, basename(compiledPath));
  await copyFile(compiledPath, cliEntrypoint);

  const chunksSourceDir = join(dirname(compiledPath), 'chunks');
  const chunksDestDir = join(libDir, 'chunks');
  if (existsSync(chunksSourceDir)) {
    await rm(chunksDestDir, { recursive: true, force: true });
    await copyDirectoryRecursive(chunksSourceDir, chunksDestDir);
  } else {
    await rm(chunksDestDir, { recursive: true, force: true });
  }

  return cliEntrypoint;
}

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

    // Copy the compiled CLI plus any emitted Rollup chunks to ~/.fleet/lib.
    // The CLI is ESM and may import ./chunks/*.mjs helper files.
    cliEntrypoint = await installBundledCliArtifacts(compiledPath, libDir);

    wrapperContent = `#!/bin/bash
# Fleet CLI — connects to running Fleet app via Unix socket
${nodeResolverScript}
FLEET_DIR="$(dirname "$(dirname "$0")")"
exec node "$FLEET_DIR/lib/${basename(cliEntrypoint)}" "$@"
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
exec node "$FLEET_DIR/lib/${basename(cliEntrypoint)}" "$@"
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

// ── installOpencodePlugin ────────────────────────────────────────────────────
//
// Copies the Fleet opencode plugin and skill file into the opencode config
// directory so the opencode agent can discover Fleet tools when running inside
// a Fleet terminal. Overwrites on every launch to stay in sync with the app
// version.
//
// Also ensures @opencode-ai/plugin is declared in the opencode package.json
// (OpenCode runs bun install at startup to install deps). Only writes
// package.json when something changed — never corrupts user content.
//
// The plugin self-guards: it checks process.env.FLEET_SESSION so Fleet tools
// only register when opencode is running inside a Fleet PTY.

export async function installOpencodePlugin(): Promise<void> {
  const opencodeHome = join(homedir(), '.config', 'opencode');

  if (!existsSync(opencodeHome)) {
    log.debug('opencode not installed, skipping plugin install');
    return;
  }

  // Locate the source files in the Fleet app bundle
  const mainDir = dirname(fileURLToPath(import.meta.url));

  const candidatePluginPaths = [
    join(mainDir, '..', '..', 'resources', 'opencode-plugin', 'fleet.ts'),
    join(process.resourcesPath ?? '', 'app.asar.unpacked', 'resources', 'opencode-plugin', 'fleet.ts')
  ];

  const candidateSkillPaths = [
    join(mainDir, '..', '..', 'resources', 'opencode-plugin', 'SKILL.md'),
    join(process.resourcesPath ?? '', 'app.asar.unpacked', 'resources', 'opencode-plugin', 'SKILL.md')
  ];

  // ── Install plugin file ──────────────────────────────────────────────────

  let pluginContent: string | null = null;
  for (const candidate of candidatePluginPaths) {
    if (existsSync(candidate)) {
      pluginContent = await readFile(candidate, 'utf8');
      break;
    }
  }

  if (pluginContent) {
    const pluginsDir = join(opencodeHome, 'plugins');
    try {
      await mkdir(pluginsDir, { recursive: true });
    } catch (err) {
      log.warn('could not create opencode plugins directory', {
        path: pluginsDir,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    const destPath = join(pluginsDir, 'fleet.ts');
    await writeFile(destPath, pluginContent, 'utf8');
    log.info('installed fleet opencode plugin', { path: destPath });
  } else {
    log.warn('opencode plugin source not found, skipping plugin install', {
      candidates: candidatePluginPaths
    });
  }

  // ── Install skill file ───────────────────────────────────────────────────

  let skillContent: string | null = null;
  for (const candidate of candidateSkillPaths) {
    if (existsSync(candidate)) {
      skillContent = await readFile(candidate, 'utf8');
      break;
    }
  }

  if (skillContent) {
    const skillsDir = join(opencodeHome, 'skills', 'fleet');
    try {
      await mkdir(skillsDir, { recursive: true });
      const destPath = join(skillsDir, 'SKILL.md');
      await writeFile(destPath, skillContent, 'utf8');
      log.info('installed fleet opencode skill', { path: destPath });
    } catch (err) {
      log.warn('could not create opencode skills directory', {
        path: skillsDir,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else {
    log.warn('opencode skill source not found, skipping skill install', {
      candidates: candidateSkillPaths
    });
  }

  // ── Ensure @opencode-ai/plugin dependency ─────────────────────────────────

  const pkgJsonPath = join(opencodeHome, 'package.json');
  let rawJson: string;
  let pkgJson: { dependencies?: Record<string, string> };
  let parsed = false;

  if (existsSync(pkgJsonPath)) {
    rawJson = await readFile(pkgJsonPath, 'utf8');
    try {
      pkgJson = JSON.parse(rawJson) as { dependencies?: Record<string, string> };
      parsed = true;
    } catch {
      log.warn('could not parse opencode package.json, leaving unchanged');
      return;
    }
  } else {
    rawJson = '{}';
    pkgJson = {};
    parsed = true;
  }

  pkgJson.dependencies = pkgJson.dependencies ?? {};

  if (pkgJson.dependencies['@opencode-ai/plugin'] === '*' || pkgJson.dependencies['@opencode-ai/plugin'] === 'latest') {
    pkgJson.dependencies['@opencode-ai/plugin'] = '^1';
  }

  if (!pkgJson.dependencies['@opencode-ai/plugin']) {
    pkgJson.dependencies['@opencode-ai/plugin'] = '^1';
    const newRaw = JSON.stringify(pkgJson, null, 2) + '\n';
    if (newRaw !== rawJson) {
      await writeFile(pkgJsonPath, newRaw, 'utf8');
      log.info('added @opencode-ai/plugin dependency to opencode package.json');
    }
  } else if (parsed) {
    // Update formatting only if we successfully parsed and did add/change
    const newRaw = JSON.stringify(pkgJson, null, 2) + '\n';
    if (newRaw !== rawJson) {
      await writeFile(pkgJsonPath, newRaw, 'utf8');
      log.info('updated @opencode-ai/plugin to ^1 in opencode package.json');
    }
  }
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
