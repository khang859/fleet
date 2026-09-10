import rawSchema from '../../resources/claude-code-settings.schema.json';

/**
 * The Claude Code settings key space, read from a vendored JSON Schema.
 *
 * Claude Code documents 142 top-level settings keys and adds more every
 * release, so the catalogue is data rather than hand-written TypeScript. The
 * schema supplies three things the UI needs: a description for every key, the
 * allowed values for the enumerated ones, and enough type information to tell
 * a scalar key from a list key.
 *
 * The schema is *advisory*. It is a snapshot, and Claude Code ships keys
 * before SchemaStore catches up, so nothing here ever blocks a write - an
 * unrecognised key is a warning at most. Refresh with
 * `npx tsx scripts/fetch-claude-settings-schema.ts`.
 */

/** The subset of JSON Schema draft-07 this module reads. */
export type SchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
  $ref?: string;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
};

type RootSchema = SchemaNode & { $defs?: Record<string, SchemaNode> };

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a vendored, shape-checked JSON asset
const schema = rawSchema as unknown as RootSchema;

/** Resolve a local `#/$defs/foo` reference. Remote refs are not followed. */
function deref(node: SchemaNode | undefined): SchemaNode | undefined {
  if (!node) return undefined;
  let current = node;
  // A malformed schema could point a $ref at itself; cap the chain rather
  // than spin.
  for (let hops = 0; current.$ref !== undefined && hops < 8; hops += 1) {
    const match = /^#\/\$defs\/(.+)$/.exec(current.$ref);
    if (!match) return current;
    const target = schema.$defs?.[match[1]];
    if (!target) return current;
    current = target;
  }
  return current;
}

/**
 * A node's branches when it is a union (`anyOf` / `oneOf`), or just itself.
 *
 * Several Claude Code keys are `string | object` - `statusLine` and
 * `apiKeyHelper`, for example - so a lookup that only read the top node would
 * miss the object branch's properties.
 */
function branches(node: SchemaNode): SchemaNode[] {
  const union = node.anyOf ?? node.oneOf;
  if (!union) return [node];
  return union.map((b) => deref(b)).filter((b): b is SchemaNode => b !== undefined);
}

/**
 * The schema for a settings key, addressed by its path from the file root.
 *
 * `schemaForPath(['permissions', 'defaultMode'])` returns the node carrying
 * that key's enum. Returns `undefined` for a key the schema does not describe,
 * which is the signal to warn rather than to refuse.
 */
export function schemaForPath(path: string[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = schema;
  for (const segment of path) {
    if (!node) return undefined;
    let next: SchemaNode | undefined;
    for (const branch of branches(node)) {
      const child = branch.properties?.[segment];
      if (child) {
        next = deref(child);
        break;
      }
      // A free-form map such as `env`: every member shares one value schema.
      if (typeof branch.additionalProperties === 'object') {
        next = deref(branch.additionalProperties);
        break;
      }
    }
    node = next;
  }
  return node;
}

/** Every top-level settings key, sorted, for completion and for unknown-key checks. */
export function topLevelKeys(): string[] {
  return Object.keys(schema.properties ?? {}).sort();
}

/** The keys of the object at `path`, for completion inside a nested object. */
export function keysAtPath(path: string[]): string[] {
  const node = path.length === 0 ? schema : schemaForPath(path);
  if (!node) return [];
  const keys = new Set<string>();
  for (const branch of branches(node)) {
    for (const key of Object.keys(branch.properties ?? {})) keys.add(key);
  }
  return [...keys].sort();
}

/** The allowed values for an enumerated key, or an empty list. */
export function enumAtPath(path: string[]): string[] {
  const node = schemaForPath(path);
  if (!node) return [];
  for (const branch of branches(node)) {
    if (branch.enum) return branch.enum.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/**
 * The schema for one element of a list key, with any `$ref` followed.
 *
 * `schemaForPath` derefs the node it returns but not that node's children, so
 * reading `.items` directly hands back a bare `$ref` - the permission lists all
 * point at `#/$defs/permissionRule`. Callers that want the element contract
 * (its description, or an enum to complete from) need this instead.
 */
export function itemsAtPath(path: string[]): SchemaNode | undefined {
  const node = schemaForPath(path);
  if (!node) return undefined;
  for (const branch of branches(node)) {
    if (branch.items) return deref(branch.items);
  }
  return undefined;
}

/** A key's documented description, for a tooltip or a completion detail line. */
export function descriptionAtPath(path: string[]): string | undefined {
  const node = schemaForPath(path);
  if (!node) return undefined;
  for (const branch of branches(node)) {
    if (branch.description) return branch.description;
  }
  return node.description;
}

/**
 * Whether a key holds a list.
 *
 * This decides how precedence is reported, not just how a control is drawn:
 * Claude Code *combines* list keys across settings files instead of letting
 * the narrowest file replace the others, so calling a list key "overridden"
 * would be wrong. Keys with their own resolution rules are excluded upstream
 * by `classifyKey`, not here.
 */
export function isListKey(path: string[]): boolean {
  const node = schemaForPath(path);
  if (!node) return false;
  return branches(node).some((b) => b.type === 'array' || b.type?.includes('array') === true);
}

/** Whether the schema describes this top-level key at all. */
export function isKnownTopLevelKey(key: string): boolean {
  return schema.properties?.[key] !== undefined;
}
