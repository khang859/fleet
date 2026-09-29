import { z } from 'zod';
import { TELEPROMPTER_ACTIONS } from '../../shared/teleprompter';

export const TeleprompterCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum([...TELEPROMPTER_ACTIONS, 'open', 'close']) }),
  z.object({ type: z.literal('fontSize'), delta: z.number().finite() }),
  z.object({ type: z.literal('opacity'), value: z.number().finite() })
]);

export const TeleprompterSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('clipboard') }),
  z.object({ kind: z.literal('pick') })
]);

export const TeleprompterResizeSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
});
