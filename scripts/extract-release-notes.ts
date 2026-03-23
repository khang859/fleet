import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: extract-release-notes.ts <output-path>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version as string;

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

const config = {
  releaseInfo: {
    releaseNotes,
  },
};

writeFileSync(outputPath, JSON.stringify(config, null, 2));
console.log(`Wrote release notes for v${version} to ${outputPath}`);
