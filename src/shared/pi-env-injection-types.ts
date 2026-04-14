import { z } from 'zod';

export const PiBedrockCredentialModeSchema = z.enum(['profile', 'keys', 'chain']);
export type PiBedrockCredentialMode = z.infer<typeof PiBedrockCredentialModeSchema>;

export const PiBedrockInjectionSchema = z.object({
  mode: PiBedrockCredentialModeSchema.default('chain'),
  region: z.string().optional(),
  profile: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKeyEnc: z.string().optional(),
  sessionTokenEnc: z.string().optional()
});
export type PiBedrockInjection = z.infer<typeof PiBedrockInjectionSchema>;

export const PiEnvInjectionSchema = z
  .object({
    bedrock: PiBedrockInjectionSchema.optional()
  })
  .passthrough();
export type PiEnvInjection = z.infer<typeof PiEnvInjectionSchema>;

/** Safe-for-IPC view: secrets collapsed to a presence flag. */
export type RedactedBedrock = {
  mode: PiBedrockCredentialMode;
  region?: string;
  profile?: string;
  accessKeyId?: string;
  secretAccessKeyPresent: boolean;
  sessionTokenPresent: boolean;
};

/**
 * Patch accepted by PiEnvInjectionManager.writeBedrock and by the preload.
 * Shared so the renderer can type preload calls without reaching into main/.
 * Secret fields are plaintext at the boundary and encrypted on arrival.
 */
export type BedrockWritePatch = {
  mode?: PiBedrockCredentialMode;
  region?: string;
  profile?: string;
  accessKeyId?: string;
  /** Plaintext; encrypted on write. Empty string clears the stored secret. */
  secretAccessKey?: string;
  sessionToken?: string;
};
