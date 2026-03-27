// src/main/image-providers/action-types.ts

export type ImageActionConfig = {
  id: string;
  actionType: string;
  provider: string;
  name: string;
  description: string;
  endpoint: string;
  inputMapping: (imageUrl: string) => Record<string, unknown>;
  outputMapping: (response: unknown) => { url: string; width: number; height: number };
  outputFormat: string;
};

/** Serializable subset sent to the renderer / CLI — no functions */
export type ImageActionInfo = {
  id: string;
  actionType: string;
  provider: string;
  name: string;
  description: string;
  model: string;
};

const FAL_RUN_PREFIX = 'https://fal.run/';

export function toActionInfo(config: ImageActionConfig): ImageActionInfo {
  return {
    id: config.id,
    actionType: config.actionType,
    provider: config.provider,
    name: config.name,
    description: config.description,
    model: config.endpoint.startsWith(FAL_RUN_PREFIX)
      ? config.endpoint.slice(FAL_RUN_PREFIX.length)
      : config.endpoint
  };
}
