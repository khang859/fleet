import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import { createLogger } from './logger';
import { PI_BUILT_IN_PROVIDERS } from '../shared/pi-presets';
import type { BuiltInProviderStatus, ModelEntry } from '../shared/pi-config-types';

const log = createLogger('pi-auth-inspector');

const AuthMapSchema = z.record(z.string(), z.unknown());

const ModelCatalogItemSchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string().optional()
});
const ModelCatalogSchema = z.array(z.unknown());

type PiAuthInspectorOptions = {
  authPath?: string;
  /** Path to installed pi's models.generated.ts for the model catalog, if available. */
  modelCatalogPath?: string;
};

export class PiAuthInspector {
  private readonly authPath: string;
  private readonly modelCatalogPath?: string;

  constructor(opts: PiAuthInspectorOptions = {}) {
    this.authPath = opts.authPath ?? join(homedir(), '.pi', 'agent', 'auth.json');
    this.modelCatalogPath = opts.modelCatalogPath;
  }

  async getBuiltInStatus(): Promise<BuiltInProviderStatus[]> {
    const authMap = await this.readAuthMap();
    return PI_BUILT_IN_PROVIDERS.map((p) => {
      const auth = authMap[p.id];
      if (auth && typeof auth === 'object' && 'oauth' in auth) {
        return {
          id: p.id,
          label: p.label,
          authenticated: true,
          method: 'oauth' as const,
          envVarName: p.envVar,
          hint: p.hint
        };
      }
      if (p.envVar && process.env[p.envVar]) {
        return {
          id: p.id,
          label: p.label,
          authenticated: true,
          method: 'env-var' as const,
          envVarName: p.envVar,
          hint: p.hint
        };
      }
      return {
        id: p.id,
        label: p.label,
        authenticated: false,
        method: 'none' as const,
        envVarName: p.envVar,
        hint: p.hint
      };
    });
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    if (!this.modelCatalogPath) return [];
    try {
      const text = await readFile(this.modelCatalogPath, 'utf-8');
      const match = text.match(/MODELS\s*=\s*(\[[\s\S]*?\]);/);
      if (!match) return [];
      const rawArray = ModelCatalogSchema.parse(JSON.parse(match[1]));
      const results: ModelEntry[] = [];
      for (const raw of rawArray) {
        const item = ModelCatalogItemSchema.safeParse(raw);
        if (!item.success) continue;
        results.push({
          providerId: item.data.provider,
          modelId: item.data.id,
          label: item.data.name ?? item.data.id
        });
      }
      return results;
    } catch (err) {
      log.debug('model catalog unavailable', { err: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async readAuthMap(): Promise<Record<string, unknown>> {
    try {
      const text = await readFile(this.authPath, 'utf-8');
      const result = AuthMapSchema.safeParse(JSON.parse(text));
      return result.success ? result.data : {};
    } catch {
      return {};
    }
  }
}
