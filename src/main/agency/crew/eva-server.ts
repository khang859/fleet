import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { CrewModel, EvaServer } from '../../../shared/agency-crew';
import type { AgentCatalogModel } from '../../../shared/agent-types';
import type { Captured } from '../exec';

/** The settings Fleet reads of eva's. Its key and every other setting stay in the file. */
const KEYS = ['provider', 'base_url', 'model'] as const;
type Key = (typeof KEYS)[number];

/** The variable that takes each setting's place, as eva's docs list them. */
const ENV: Record<Key, string> = {
  provider: 'CHAT_PROVIDER',
  base_url: 'CHAT_BASE_URL',
  model: 'CHAT_MODEL'
};

/** Each provider's address and model when eva's settings give none. */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string | null; model: string | null }> = {
  'llama.cpp': { baseUrl: 'http://localhost:11436/v1', model: 'qwen3.6-abliterated' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash' },
  'openai-compatible': { baseUrl: null, model: null }
};

const MODELS_TIMEOUT_MS = 5_000;

/**
 * The top-level `provider`, `base_url` and `model` lines of eva's
 * `config.toml`, parsed alone. The other lines, the key's among them, are
 * dropped before anything parses them, so the key is never a value here.
 */
export function evaSettings(text: string): Partial<Record<Key, string>> {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    if (KEYS.some((key) => new RegExp(`^\\s*${key}\\s*=`).test(line))) lines.push(line);
  }
  try {
    const parsed = parseToml(lines.join('\n'));
    return Object.fromEntries(
      KEYS.flatMap((key) => {
        const value = parsed[key];
        return typeof value === 'string' && value.trim() !== '' ? [[key, value.trim()]] : [];
      })
    );
  } catch {
    return {};
  }
}

function isLocal(provider: string, baseUrl: string | null): boolean {
  if (provider === 'llama.cpp') return true;
  if (baseUrl === null) return false;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** The server eva uses: its settings, with the variables a pane sets in their place. */
export function evaServer(
  settings: Partial<Record<Key, string>>,
  env: Partial<Record<Key, string>>
): EvaServer {
  const pick = (key: Key): string | undefined => env[key] ?? settings[key];
  const provider = pick('provider') ?? 'llama.cpp';
  const defaults = PROVIDER_DEFAULTS[provider] ?? { baseUrl: null, model: null };
  const baseUrl = (pick('base_url') ?? defaults.baseUrl)?.replace(/\/+$/, '') ?? null;
  return {
    provider,
    baseUrl,
    model: pick('model') ?? defaults.model,
    local: isLocal(provider, baseUrl)
  };
}

/** Runs a line in the shell a terminal pane gets, in `cwd`. */
export type EvaShell = (line: string, cwd: string) => Promise<Captured>;

/** The line `awk` prints for a non-empty `api_key`, in place of the line itself. */
const KEY_SET = '# api_key set';

/**
 * The shell line that reads eva's server as a pane would: each of the three
 * variables as `NAME=value`, `CHAT_API_KEY=set` for a key that has a value,
 * then the top-level `provider`, `base_url` and `model` lines of
 * `config.toml`, and `KEY_SET` for an `api_key` line with a value. The key
 * itself stays in the shell: Fleet is handed neither its value nor any other
 * line of the file. Each variable is named, so a trimmed empty one moves no
 * other.
 */
const READ_LINE = [
  ...KEYS.map((k) => `printf '${ENV[k]}=%s\\n' "$${ENV[k]}"`),
  `printf 'CHAT_API_KEY=%s\\n' "\${CHAT_API_KEY:+set}"`,
  'f="${EVA_HOME:-$HOME/.eva}/config.toml"',
  `[ -r "$f" ] && awk '/^[[:space:]]*\\[/ { exit } /^[[:space:]]*(${KEYS.join('|')})[[:space:]]*=/ { print; next } /^[[:space:]]*api_key[[:space:]]*=[[:space:]]*"[^"]/ { print "${KEY_SET}" }' "$f"`
].join('; ');

/**
 * eva's server as a crew pane in `cwd` would start it, and whether eva has
 * a key, from its settings or its environment.
 */
export async function readEvaServer(
  cwd: string,
  shell: EvaShell
): Promise<{ server: EvaServer; keySet: boolean | null }> {
  const out = await shell(READ_LINE, cwd);
  if (out === null) return { server: evaServer({}, {}), keySet: null };
  const vars = new Map<string, string>();
  const file: string[] = [];
  for (const line of out.stdout.split('\n')) {
    const named = /^(CHAT_[A-Z_]+)=(.*)$/.exec(line);
    if (named) vars.set(named[1], named[2].trim());
    else file.push(line);
  }
  const env = Object.fromEntries(
    KEYS.flatMap((key) => {
      const v = vars.get(ENV[key]);
      return v ? [[key, v]] : [];
    })
  );
  return {
    server: evaServer(evaSettings(file.join('\n')), env),
    keySet: vars.get('CHAT_API_KEY') === 'set' || file.some((l) => l.trim() === KEY_SET)
  };
}

const ServerModels = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      context_length: z.number().optional(),
      meta: z.object({ n_ctx_train: z.number().optional() }).optional()
    })
  )
});

/**
 * The models eva's server lists: OpenRouter's that call tools, from the
 * catalog Fleet keeps, or a local server's `/models`, asked with no key.
 * Null when the list cannot be read.
 */
export async function evaModels(
  server: EvaServer,
  deps: { openRouter: () => Promise<AgentCatalogModel[]>; fetch: typeof fetch }
): Promise<CrewModel[] | null> {
  if (server.provider === 'openrouter') {
    const models = await deps.openRouter().catch(() => []);
    if (models.length === 0) return null;
    return models
      .filter((m) => m.supportsTools)
      .map((m) => ({ id: m.id, contextLimit: m.contextLimit, cost: m.cost }));
  }
  if (server.baseUrl === null) return null;
  try {
    const res = await deps.fetch(`${server.baseUrl}/models`, {
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const parsed = ServerModels.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.data.map((m) => ({
      id: m.id,
      contextLimit: m.context_length ?? m.meta?.n_ctx_train ?? null,
      cost: null
    }));
  } catch {
    return null;
  }
}
