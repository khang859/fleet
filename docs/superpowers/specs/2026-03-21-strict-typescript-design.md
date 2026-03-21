# Strict TypeScript Enforcement

## Goal

Eliminate all `as` type casts from source code and all `any` types from the entire codebase. Enforce these rules via ESLint to prevent regressions.

## Scope

- **Source files** (`src/main/`, `src/renderer/`, `src/preload/`, `src/shared/`, `scripts/`): No `as` type casts, no `any`. `as const` is allowed.
- **Test files** (`**/__tests__/**`): No `any`, but `as` casts allowed for mocking
- **Reference code** (`reference/`): Excluded — not our code

## Part 1: ESLint Configuration

Add to `eslint.config.mjs`:

1. **`@typescript-eslint/no-explicit-any: "error"`** — applied globally to all `.ts`/`.tsx` files
2. **`@typescript-eslint/consistent-type-assertions`** — for source files, use `assertionStyle: "as"` with `objectLiteralTypeAssertions: "never"` combined with a custom override. Since `assertionStyle: "never"` also bans `as const`, use `assertionStyle: "as"` and pair it with `@typescript-eslint/no-unsafe-type-assertion: "error"` to flag unsafe casts while preserving `as const`.
3. **Override for test files** (`**/__tests__/**`) — disable the unsafe type assertion rule to allow `as` casts for mocking

Note: The exact ESLint rule combination should be validated during implementation. The goal is: ban `as X` casts in source, allow `as const`, allow `as` in tests.

## Part 2: Fix Existing Violations

### `as` casts in source files

Common fix patterns by category:

| Pattern | Fix |
|---------|-----|
| DOM element casts (`as HTMLDivElement`) | Use generic methods: `querySelector<HTMLDivElement>(...)` |
| Event handler casts | Properly type event parameters |
| API/IPC response casts | Add typed IPC wrappers (see IPC Boundaries below) |
| Object literal casts (`{} as Foo`) | Use `satisfies` or fix the type definition |
| `as unknown as X` chains | Fix underlying type design (see Proxy Pattern below) |
| Enum/string literal casts | Use `satisfies` or `as const` |
| Error code casts (`as Error & { code }`) | Use helper function (see Error Pattern below) |

### `any` annotations (all files)

Replace with proper types — `unknown` with narrowing, or specific types.

### Key patterns requiring specific strategies

**Error code pattern** (~56 occurrences in `socket-server.ts`):
```typescript
// Before: as Error & { code: string }
// After: helper function
function toCodedError(err: unknown): Error & { code: string } {
  const e = err instanceof Error ? err : new Error(String(err))
  return Object.assign(e, { code: (err as any)?.code ?? 'UNKNOWN' })
}
// Or use a type guard: function hasCode(e: Error): e is Error & { code: string }
```

**Proxy/RPC pattern** (`starbase-runtime-socket-services.ts`):
Define a `RemoteServiceProxy<T>` type that wraps method signatures to return `Promise<Awaited<ReturnType>>`, eliminating the need for `as unknown as ServiceRegistry[...]`.

**Electron IPC boundaries**:
Create typed IPC wrappers that provide proper return types, avoiding `any` from `ipcRenderer.invoke`. Pattern: overloaded invoke signatures or a typed channel map.

### `unknown` proliferation strategy

When replacing `any` or removing casts, prefer:
1. Specific types when known
2. Type predicates / type guard functions for repeated narrowing patterns
3. `unknown` + narrowing as last resort — keep narrowing close to the boundary

## Execution Strategy

Work in phases, dependency order:

1. **Phase 1 — ESLint config + shared types** (`src/shared/`, `eslint.config.mjs`)
2. **Phase 2 — Main process** (`src/main/` source files, heaviest work)
3. **Phase 3 — Renderer + preload** (`src/renderer/`, `src/preload/`)
4. **Phase 4 — Scripts + test `any` cleanup** (`scripts/`, test file `any` removals)

For each file:
1. Fix `any` types and `as` casts
2. Improve upstream types where needed
3. Verify with `tsc --noEmit`

## Success Criteria

- `npx eslint .` passes with the new rules
- `npx tsc --noEmit` passes for both tsconfig projects
- No `as` type casts in source files (excluding `as const`)
- No `any` types anywhere
- All existing tests pass
