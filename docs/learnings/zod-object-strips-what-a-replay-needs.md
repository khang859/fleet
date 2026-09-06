# A narrowing parse empties the round it was meant to carry

## What happened

The Responses transport parses each finished output item with zod before reading it.
The schema was a plain `z.object`, listing the keys the parser acts on: `type`, `id`, `status`, `call_id`, `name`, `arguments`, `role`, `query`, `result`, `content`.

Zod's plain object **drops every key it was not told about**.
So by the time an item reached the rest of the file it had lost:

- `encrypted_content` on a reasoning item, which is the model's own chain of thought carried between rounds
- `instance_name` on an advisor item, which is what OpenRouter keys cross-request memory on
- whatever a server tool this build has never heard of states as its arguments

Every one of those is a key that exists *only* to be handed back unchanged on the next request.

The bug was invisible in two ways.
Nothing threw, because the keys were optional.
And the file already had a comment promising the opposite - "unknown types are kept rather than dropped" - which was true of the item's `type` and false of everything inside it.

It surfaced only when a review asked why an advisor consulted with deferral on forgets the consultation.

## The fix

`z.looseObject` instead of `z.object`, and a comment saying why it is load bearing rather than incidental.

```ts
const outputItemSchema = z.looseObject({
  type: z.string(),
  ...
});
```

A test asserts the surviving key directly, against the captured fixture rather than a hand-written one:

```ts
expect(reasoning).toHaveProperty('encrypted_content');
expect(String(reasoning?.encrypted_content)).not.toBe('');
```

## The rule

When a parsed object is going to be **sent back**, the parse must be loose.
`z.object` is right for reading a value and wrong for carrying one.

The tell is the word "opaque" or "replay" or "unchanged" anywhere near the type.
If the code's job is to hand something back byte for byte, then any schema between the wire and the hand-back is a place bytes go missing, and it will do it silently.
