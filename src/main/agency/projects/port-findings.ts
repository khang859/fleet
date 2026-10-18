import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { FixedPort } from '../../../shared/agency-projects';
import type { RepoReader } from './repo-reader';

/**
 * The port settings of a repository, for project setup: the port variables
 * its env files, runner scripts and package scripts read, like
 * `JOURNEY_API_PORT=3030`, and the host ports its Compose files fix, like
 * Postgres on `5432:5432`. Fleet moves each port variable to a free port per
 * job workspace; a fixed port cannot move, so it limits how many stacks run.
 */

export type PortFindings = { portVars: string[]; fixedPorts: FixedPort[] };

/** `PORT=3000`, `API_PORT: 3030`, `${WEB_PORT:-3000}`, `${PORT}` and `$PORT`, with the default when there is one. */
const PORT_VAR =
  /\$\{((?:[A-Z][A-Z0-9]*_)*PORT)(?::?-(\d{2,5}))?\}|\$((?:[A-Z][A-Z0-9]*_)*PORT)\b|\b((?:[A-Z][A-Z0-9]*_)*PORT)\s*[=:]\s*["']?(\d{2,5})?/g;

const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml'
];

/** The most files read for port variables, so a huge repository does not slow setup. */
const MAX_FILES = 40;

const isEnvFile = (path: string): boolean =>
  /^\.env(\..+)?$/.test(basename(path)) && path.split('/').length <= 3;

/** Shell scripts at the root or in `scripts/` and `bin/`, like `./journey` or `scripts/dev.sh`. */
const isScript = (path: string): boolean => {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  const dir = parts.length === 1 ? '' : parts.slice(0, -1).join('/');
  if (dir !== '' && dir !== 'scripts' && dir !== 'bin') return false;
  return name.endsWith('.sh') || (!name.includes('.') && name !== '');
};

/** Each port variable a text names, with its default port when it gives one. */
export function portVarsIn(text: string): Array<{ name: string; port: number | null }> {
  const found: Array<{ name: string; port: number | null }> = [];
  for (const m of text.matchAll(PORT_VAR)) {
    // Each of the three forms fills its own groups; the others are undefined.
    const groups: Array<string | undefined> = [...m];
    const port = groups[2] ?? groups[5];
    found.push({
      name: groups[1] ?? groups[3] ?? groups[4] ?? '',
      port: port === undefined ? null : Number(port)
    });
  }
  return found;
}

const ComposePort = z.union([
  z.string(),
  z.number(),
  z.object({ published: z.union([z.string(), z.number()]).optional() }).loose()
]);
const Compose = z
  .object({
    services: z
      .record(
        z.string(),
        z
          .object({ ports: z.array(ComposePort).optional() })
          .loose()
          .nullable()
      )
      .optional()
  })
  .loose();

/** The host side of a Compose port entry, or null when Docker picks the host port. */
function hostPort(entry: z.infer<typeof ComposePort>): string | null {
  if (typeof entry === 'number') return null;
  if (typeof entry === 'object')
    return entry.published === undefined ? null : String(entry.published);
  const parts = entry.replace(/\/(tcp|udp)$/, '').split(/:(?![^{]*\})/);
  return parts.length < 2 ? null : (parts.at(-2) ?? null);
}

/** Fixed host ports, and the port variables that publish the others, from one Compose file. */
export function composePorts(text: string): {
  fixed: FixedPort[];
  vars: Array<{ name: string; port: number | null }>;
} {
  let parsed: z.infer<typeof Compose>;
  try {
    parsed = Compose.parse(parseYaml(text));
  } catch {
    return { fixed: [], vars: [] };
  }
  const fixed: FixedPort[] = [];
  const vars: Array<{ name: string; port: number | null }> = [];
  for (const [service, def] of Object.entries(parsed.services ?? {})) {
    for (const entry of def?.ports ?? []) {
      const host = hostPort(entry);
      if (host === null) continue;
      if (/^\d+$/.test(host)) fixed.push({ port: Number(host), service });
      else vars.push(...portVarsIn(host));
    }
  }
  return { fixed, vars };
}

/**
 * A repository's port settings. A variable whose default is a fixed port
 * points at that fixed service, like `DB_PORT=5432` for the Compose Postgres,
 * so it is left alone: moving it would lose the database.
 */
export async function findPorts(reader: RepoReader): Promise<PortFindings> {
  const all = reader.list('');
  const fixed: FixedPort[] = [];
  const vars: Array<{ name: string; port: number | null }> = [];
  for (const file of COMPOSE_FILES.filter((f) => all.includes(f))) {
    const text = await reader.read(file);
    if (text === null) continue;
    const found = composePorts(text);
    fixed.push(...found.fixed);
    vars.push(...found.vars);
  }
  const scanned = all.filter((f) => f === 'package.json' || isEnvFile(f) || isScript(f));
  for (const file of scanned.slice(0, MAX_FILES)) {
    const text = await reader.read(file);
    if (text === null || (isScript(file) && !file.endsWith('.sh') && !text.startsWith('#!'))) {
      continue;
    }
    vars.push(...portVarsIn(text));
  }
  const fixedPorts = fixed.filter((f, i) => fixed.findIndex((o) => o.port === f.port) === i);
  const taken = new Set(fixedPorts.map((f) => f.port));
  const pointsAtFixed = new Set(
    vars.filter((v) => v.port !== null && taken.has(v.port)).map((v) => v.name)
  );
  const portVars = [...new Set(vars.map((v) => v.name))].filter((n) => !pointsAtFixed.has(n));
  return { portVars, fixedPorts };
}
