import { useState } from 'react';

/** What main answers to a client's action on a card: done, or why not. */
export type Refusable = { ok: true } | { ok: false; reason: string };

export type RefusableAction<A> = {
  busy: boolean;
  /** Main's reason for the last refusal, until the next try. */
  refused: string | null;
  run: (arg: A) => Promise<void>;
};

/** Send one action at a time from a card, and keep main's reason when it refuses. */
export function useRefusable<A>(send: (arg: A) => Promise<Refusable>): RefusableAction<A> {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const run = async (arg: A): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const result = await send(arg).catch(
      (err: unknown): Refusable => ({ ok: false, reason: String(err) })
    );
    setBusy(false);
    if (!result.ok) setRefused(result.reason);
  };
  return { busy, refused, run };
}
