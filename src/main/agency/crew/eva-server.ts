import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { CrewModel, EvaServer } from '../../../shared/agency-crew';
import type { AgentCatalogModel } from '../../../shared/agent-types';
import type { Captured } from '../exec';
import { readTextOrNull } from '../projects/files';

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

export type EvaServerDeps = {
  /** Runs a line in the shell a terminal pane gets, in `cwd`. */
  shell: (line: string, cwd: string) => Promise<Captured>;
  readText: (path: string) => Promise<string | null>;
  home: string;
};

/**
 * eva's server as a crew pane in `cwd` would start it. The pane's shell is
 * asked for `EVA_HOME` and the three variables by name, never for
 * `CHAT_API_KEY`.
 */
export async function readEvaServer(cwd: string, deps: EvaServerDeps): Promise<EvaServer> {
  const names = ['EVA_HOME', ...KEYS.map((k) => ENV[k])];
  const out = await deps.shell(`printf '%s\\n' ${names.map((n) => `"$${n}"`).join(' ')}`, cwd);
  const values = out?.code === 0 ? out.stdout.split('\n') : [];
  const value = (i: number): string | undefined => values[i]?.trim() || undefined;
  const env = Object.fromEntries(
    KEYS.flatMap((key, i) => {
      const v = value(i + 1);
      return v === undefined ? [] : [[key, v]];
    })
  );
  const text = await deps.readText(join(value(0) ?? join(deps.home, '.eva'), 'config.toml'));
  return evaServer(text === null ? {} : evaSettings(text), env);
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

export function paneEvaServerDeps(shell: EvaServerDeps['shell']): EvaServerDeps {
  return { shell, readText: readTextOrNull, home: homedir() };
}
