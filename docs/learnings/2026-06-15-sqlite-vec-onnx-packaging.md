# Learnings: sqlite-vec + transformers.js for the Learnings vector KB (2026-06-15)

Captured during the packaging spike for semantic search over the Learnings KB
(`sqlite-vec` + `@huggingface/transformers` local embeddings, exposed to Rune and
Claude Code via an MCP server).

## vec0 rowids must be bound as BigInt

**Problem:** Inserting into a `sqlite-vec` `vec0` virtual table with a plain JS
number rowid throws `SqliteError: Only integers are allows for primary key values`.
better-sqlite3 binds a JS `number` as SQLite REAL, and vec0 strictly requires an
INTEGER primary key.

**Fix:** Bind the rowid as `BigInt`:

```ts
ins.run(BigInt(rowid), Buffer.from(new Float32Array(vec).buffer)); // ✅
// ins.run(rowid, ...)  // ❌ "Only integers are allows for primary key"
```

Reads come back as `BigInt` too, so `Number(row.rowid)` when mapping out.

## sqlite-vec extension path must be translated to app.asar.unpacked

**Problem:** `sqlite-vec`'s `getLoadablePath()` (and `load()`) resolve the native
`vec0.dylib` via `import.meta.resolve`, which in a packaged build points *inside*
`app.asar`. `db.loadExtension()` calls `dlopen`, which cannot read a file inside the
asar archive, so the load fails in production (works in dev).

**Fix:** Add the platform packages to `asarUnpack` in `electron-builder.yml`:

```yaml
asarUnpack:
  - node_modules/onnxruntime-node/**
  - node_modules/sqlite-vec/**
  - node_modules/sqlite-vec-*/**   # per-platform: sqlite-vec-darwin-arm64, etc.
```

…and translate the resolved path before loading:

```ts
const p = getLoadablePath().replace('app.asar', 'app.asar.unpacked');
db.loadExtension(p);
```

Verified in a signed `--dir` build: `vec0.dylib` and onnxruntime's
`onnxruntime_binding.node` + sibling `libonnxruntime.*.dylib` all land in
`app.asar.unpacked/node_modules/...` and load from the packaged runtime.

## onnxruntime-node ships a .node binding AND a sibling shared lib

`onnxruntime-node` is what `@huggingface/transformers` uses on Node. Its
`onnxruntime_binding.node` links against a sibling `libonnxruntime.*.dylib`/`.so` in
the same dir. electron-builder's smart-unpack detects the `.node` but the explicit
`node_modules/onnxruntime-node/**` glob guarantees the shared lib comes along too.
`@huggingface/transformers` itself is pure JS and stays inside the asar — only the
native deps need unpacking.

## Embeddings run off the main thread

transformers.js inference (onnxruntime-node) is synchronous CPU work that would block
the Electron main thread. It runs in a `worker_threads` worker; the main thread only
does the (fast) SQLite vec writes/reads. N-API modules are ABI-stable, so the same
onnxruntime binary loads under both Electron and plain Node.

## Testing native deps under the Electron ABI

`better-sqlite3` is built for Electron's ABI via `electron-builder install-app-deps`.
To run a Node-level script against it, use Electron's bundled Node:
`ELECTRON_RUN_AS_NODE=1 npx electron script.mjs` (the script must live inside the
project so bare imports resolve from `node_modules`).
