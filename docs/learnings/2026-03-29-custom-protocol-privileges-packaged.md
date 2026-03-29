## Custom protocol schemes need direct file reads for packaged builds

**Problem:** `fleet-asset://` protocol worked in dev but mascot sprites showed nothing in the packaged (release) app.

**Root cause:** Two issues compounded:

1. The `fleet-asset://` scheme was registered with only `{ supportFetchAPI: true, stream: true }` privileges — missing `standard` and `secure`.
2. The handler used `net.fetch(\`file://\${filePath}\`)` to proxy file reads. Even when the handler returned 200 OK with correct `Content-Type: image/webp`, Chromium's CSS engine silently dropped the response when used in `background-image: url()` in production (where `webSecurity: true`).

**What didn't work:**
- Adding `corsEnabled: true` — this tells Chromium to **subject** the scheme to CORS checks, making it worse (CSS responses blocked without CORS headers).
- Adding only `standard: true, secure: true` with `net.fetch` proxy — handler returned 200 OK but CSS still didn't render the image.

**Fix:** Two changes required:
1. Register scheme with `{ standard: true, secure: true, supportFetchAPI: true, stream: true }` (no `corsEnabled`).
2. Replace `net.fetch('file://...')` proxy with direct `readFile()` returning a `new Response(data, { headers: { 'Content-Type': ... } })`.

```ts
// Before (broken in packaged builds):
return net.fetch(`file://${filePath}`);

// After (works everywhere):
const data = await readFile(filePath);
return new Response(data, {
  headers: { 'Content-Type': mime[ext] ?? 'application/octet-stream' },
});
```

**Key insight:** `net.fetch('file://...')` responses are not treated the same as direct `Response` objects by Chromium's CSS engine in packaged Electron apps. Always test custom protocols with `webSecurity: true` (production default).
