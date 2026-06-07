import { z } from 'zod';

/** A discovered .env file, relative to the active scan root. */
export const EnvFileEntrySchema = z.object({
  absPath: z.string(),
  relPath: z.string(),
  /** Folder path used for grouping; '·root' for top-level files. */
  group: z.string(),
  name: z.string(),
  /** True for .example/.sample/.template/.dist/.defaults files. */
  isTemplate: z.boolean(),
  varCount: z.number(),
  /** False when the file could not be read (shown disabled). */
  readable: z.boolean()
});
export type EnvFileEntry = z.infer<typeof EnvFileEntrySchema>;

export const EnvReadResultSchema = z.object({
  text: z.string(),
  mtimeMs: z.number()
});
export type EnvReadResult = z.infer<typeof EnvReadResultSchema>;

/** ok:false + externalChange:true means the file changed on disk since read. */
export const EnvWriteResultSchema = z.object({
  ok: z.boolean(),
  externalChange: z.boolean().optional(),
  mtimeMs: z.number()
});
export type EnvWriteResult = z.infer<typeof EnvWriteResultSchema>;

export const EnvPathResultSchema = z.object({ absPath: z.string() });
export type EnvPathResult = z.infer<typeof EnvPathResultSchema>;

export const EnvTrashResultSchema = z.object({ trashPath: z.string() });
export type EnvTrashResult = z.infer<typeof EnvTrashResultSchema>;
