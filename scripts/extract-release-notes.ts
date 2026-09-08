import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseChangelog } from '../src/shared/release-notes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: extract-release-notes.ts <output-path>');
  process.exit(1);
}

const pkgText = readFileSync(join(root, 'package.json'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns any
const pkg = JSON.parse(pkgText) as { version: string };
const version = pkg.version;

// The same split the app uses to show this version's notes once it is
// installed (`src/shared/release-notes.ts`). Shared deliberately: if the
// pipeline and the app disagreed about where a section ends, one release would
// read two different ways depending on whether you saw it before or after
// installing it.
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const entry = parseChangelog(changelog).find((e) => e.version === version);
if (!entry) {
  console.error(`No changelog entry found for ## v${version}`);
  process.exit(1);
}

const releaseNotes = entry.notes;

// Read the base electron-builder.yml and merge releaseInfo into it.
// --config <file> in electron-builder REPLACES the default config entirely,
// so we must include all base settings, not just releaseInfo.
const baseConfigText = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const baseConfig: unknown = parseYaml(baseConfigText);
if (typeof baseConfig !== 'object' || baseConfig === null || Array.isArray(baseConfig)) {
  throw new Error('electron-builder.yml did not parse to an object');
}

const mergedConfig = {
  ...baseConfig,
  releaseInfo: {
    releaseNotes
  }
};

writeFileSync(outputPath, JSON.stringify(mergedConfig, null, 2));
console.log(`Wrote merged config with release notes for v${version} to ${outputPath}`);
