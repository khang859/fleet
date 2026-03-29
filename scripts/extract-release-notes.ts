import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');

const heading = `## v${version}`;
const startIdx = lines.findIndex((l) => l.trim() === heading);
if (startIdx === -1) {
  console.error(`No changelog entry found for ${heading}`);
  process.exit(1);
}

const notes: string[] = [];
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) break;
  notes.push(lines[i]);
}

const releaseNotes = notes.join('\n').trim();

// Read the base electron-builder.yml and merge releaseInfo into it.
// --config <file> in electron-builder REPLACES the default config entirely,
// so we must include all base settings, not just releaseInfo.
const baseConfigText = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const baseConfig = parseYaml(baseConfigText) as Record<string, unknown>;

const mergedConfig = {
  ...baseConfig,
  releaseInfo: {
    releaseNotes
  }
};

writeFileSync(outputPath, JSON.stringify(mergedConfig, null, 2));
console.log(`Wrote merged config with release notes for v${version} to ${outputPath}`);
