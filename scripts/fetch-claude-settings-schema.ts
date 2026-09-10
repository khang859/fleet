import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..');

/**
 * Refreshes the vendored Claude Code settings JSON Schema.
 *
 * The schema is vendored rather than fetched at runtime for two reasons: the
 * app has to validate settings offline, and a third-party host should not be
 * able to change how Fleet behaves between launches. Updating it is therefore
 * a deliberate, reviewable commit rather than a silent download.
 *
 * Run: npx tsx scripts/fetch-claude-settings-schema.ts
 */
const SOURCE_URL = 'https://www.schemastore.org/claude-code-settings.json';
const OUTPUT_PATH = join(root, 'resources', 'claude-code-settings.schema.json');

/** Below this, the response is a redirect stub or an error page, not the schema. */
const MIN_EXPECTED_PROPERTIES = 100;

async function main(): Promise<void> {
  console.log(`Fetching ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const text = await res.text();

  let schema: { properties?: Record<string, unknown> };
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns any
    schema = JSON.parse(text) as { properties?: Record<string, unknown> };
  } catch (err) {
    console.error(`Response is not valid JSON: ${String(err)}`);
    process.exit(1);
  }

  const count = Object.keys(schema.properties ?? {}).length;
  if (count < MIN_EXPECTED_PROPERTIES) {
    console.error(
      `Refusing to write: schema has ${count} top-level properties, expected at least ${MIN_EXPECTED_PROPERTIES}.`
    );
    process.exit(1);
  }

  // Re-serialized rather than written verbatim so the committed file has stable
  // formatting and a diff between two refreshes is readable.
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH} (${count} top-level properties)`);
}

void main();
