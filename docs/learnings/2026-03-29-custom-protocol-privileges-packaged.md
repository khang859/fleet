## Custom protocol schemes need full privileges for packaged builds

**Problem:** `fleet-asset://` protocol worked in dev but mascot sprites showed nothing in the packaged (release) app.

**Root cause:** The `fleet-asset://` scheme was registered with only `{ supportFetchAPI: true, stream: true }` privileges. The copilot window uses `webSecurity: !isDev` — in dev, `webSecurity: false` disables same-origin enforcement, so the custom protocol loads fine. In production, `webSecurity: true` causes Chromium to block cross-scheme resource loading from `file://` pages to `fleet-asset://` URLs used in CSS `background-image: url()`.

**Fix:** Register the scheme with full privileges:
```ts
{ scheme: 'fleet-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
```

- `standard: true` — scheme is treated like `http://`/`https://`, enabling proper URL resolution and resource loading
- `secure: true` — treated as a secure context
- `corsEnabled: true` — allows cross-origin requests from `file://` origin

**Key insight:** Always test custom protocols with `webSecurity: true` (production default). `webSecurity: false` in dev masks many protocol registration issues.
