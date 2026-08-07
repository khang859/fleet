# A 401 is only an `UnauthorizedError` when a provider is attached

## Symptom

MCP servers imported from Claude Code and OpenCode (mobbin, in this case) showed up in the Agent settings pane as **failed**, with a raw JSON blob for an error message:

```
Error POSTing to endpoint (HTTP 401): {"error":"invalid_token", ...}
```

They should have shown **Needs sign-in** with a Sign in button.
Every unit test passed, and the OAuth flow itself worked perfectly when a server was already configured with `auth: { kind: 'oauth' }`.

## Cause

Two things, and only the second is obvious in hindsight.

**1. The SDK only classifies a 401 as an auth problem when it has somewhere to send it.**
In `@modelcontextprotocol/client` v2.0.0, `dist/index.mjs:5334`:

```js
if (response.status === 401 && this._authProvider) {
  // ... throws UnauthorizedError
}
// otherwise falls through to:
throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, { status, statusText, text })
```

Fleet only attaches an `OAuthClientProvider` when the config says `auth.kind === 'oauth'`.
A server imported from another tool has no `auth` field at all - the credential lived in that tool's own store, not in the JSON we copied.
So no provider was attached, so the 401 arrived as a generic transport error, so `err instanceof UnauthorizedError` was false, so the manager filed it under "broken server".

**2. Discovering the server needs OAuth was thrown away on restart.**
Even after signing in successfully, nothing wrote `auth: { kind: 'oauth' }` back to the config.
Next launch: no provider attached again, stored tokens never sent, server asks all over again.

## Fix

`src/main/agent/mcp/manager.ts` - treat a bare HTTP 401 from an http-transport server as an invitation to authenticate, not a failure:

```ts
const HttpStatus = z.object({ status: z.number() });

function wantsAuth(cfg: McpServerConfig, err: unknown): boolean {
  if (transportOf(cfg) !== 'http') return false;
  const parsed = HttpStatus.safeParse(err);
  return parsed.success && parsed.data.status === 401;
}
```

`src/main/agent/mcp/mcp-ipc.ts` - persist the discovery once the sign-in succeeds, then reload so it takes effect on the connection the user was waiting for:

```ts
async function rememberOAuth(deps: McpIpcDeps, name: string): Promise<void> {
  const servers = deps.getServers();
  const config = servers[name];
  if (config === undefined || config.auth?.kind === 'oauth') return;
  deps.setServers({ ...servers, [name]: { ...config, auth: { kind: 'oauth' } } });
  await deps.manager.reload();
}
```

## Lessons

**Only an end-to-end run finds this class of bug.**
Every test double in the suite attached an auth provider, because that is what a test that is *about* OAuth does.
The failing case was the config shape nobody writes by hand - the one produced by the import feature.
Running the real app against the user's real imported servers is what surfaced it, exactly as `CLAUDE.md` requires.

**Fakes have to reproduce the shape, not just the value.**
The first version of `refusingTransport` in `__tests__/fake-server.ts` threw `Object.assign(new Error(), { status: 401 })`.
That is an *own* property; the real `SdkHttpError` exposes `status` as a **prototype getter** (`get status() { return this.data.status; }`).
A reader that only walks own properties would have passed the test and failed against a real server.
Zod does read getters - verified before relying on it - but the fake now throws the SDK's real error class so the question cannot come up again.

**Read the dependency's source when its error taxonomy matters.**
The behaviour above is not in the SDK's docs. One `grep` for `401` in `node_modules/@modelcontextprotocol/client/dist/index.mjs` explained the whole thing in under a minute.
