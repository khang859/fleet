// Copies pdf.js CMap + standard-font assets into the renderer publicDir so the
// bundled viewer can render the 14 base fonts and CJK text. Run on
// install/dev/build. Generated output is gitignored.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', 'pdfjs-dist');
const destDir = join(root, 'src', 'renderer', 'public', 'pdfjs');

for (const sub of ['cmaps', 'standard_fonts']) {
  const from = join(srcDir, sub);
  const to = join(destDir, sub);
  if (!existsSync(from)) {
    console.error(`[copy-pdfjs-assets] missing ${from} — is pdfjs-dist installed?`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[copy-pdfjs-assets] copied ${sub} -> ${to}`);
}
