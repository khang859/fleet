# web_fetch: the render gate that excluded dev servers, and why the DNS pin needs node:https

Date: 2026-08-10
Area: `src/main/agent/web/`, `src/shared/agent-web.ts`

## The render gate silently excluded the case it was built for

`extractContent` falls back to rendering a page in an offscreen `BrowserWindow` when the server's own HTML has no article in it - an empty `<div id="root">` and a bundle.
The gate on that fallback was written as:

```ts
if (deps.render !== undefined && new URL(page.url).protocol === 'https:') {
```

The intent was "only render a page that resolved public", because a render happens inside Chromium, whose DNS we cannot pin.
`protocol === 'https:'` was used as the proxy for that, since `checkUrl` upgrades public `http://` to `https://` and deliberately does not upgrade local addresses.

The proxy was wrong in exactly the case the feature was sold on.
A dev server is `http://localhost:5173`, it is almost always an SPA serving an empty shell, and it stayed `http:` by design - so it never rendered, and `web_fetch` on a local dev server returned "found nothing readable on it, the page probably needs JavaScript" with a browser engine sitting idle in the same process.
A second layer would have blocked it anyway: the render session's `onBeforeRequest` filter cancelled every non-public hostname, including the page's own top-level navigation.

The fix has three parts:

- `fetchPage` carries the `HostKind` of the address it actually connected to, so the gate tests the resolved fact rather than a string that stood in for it.
- `renderPage` takes its own `allowLocal`, which is true only when *the page being rendered* is local. It is not the user's setting: a page from the internet must not reach a dev server on a machine where the user has merely allowed themselves to name one.
- Two hardened sessions rather than one filter with a flag, so the wrong page cannot be rendered under the wrong rule by a later edit. Metadata addresses are refused in both.

**Lesson:** when a guard is expressed through a proxy for the thing it means (`protocol` standing in for "resolved public"), it will eventually be right about the proxy and wrong about the thing. Carry the fact.

## `dns.lookup` takes no signal, so nothing was bounded by the deadline

The pipeline has one 30-second deadline built from `AbortSignal.any([turnSignal, AbortSignal.timeout(30_000)])`, and it was passed only to `http(s).request`.
`resolveHost` awaited `dns.lookup` with no cancellation at all, on every redirect hop.

`dns.lookup` is `getaddrinfo` on a thread-pool thread. Unlike `dns.promises.resolve()`, its options have no `signal` field - there is no cancelling it. A blackholed resolver holds it for as long as the OS is willing to wait, well past the app's own budget, and the user's stop button does nothing.

What can be given up is *waiting* for it. `stopWaitingOnAbort` races the lookup against the signal and lets the lookup finish into nothing.

**Lesson:** a deadline that is only handed to the network call is not a deadline on the operation. Name resolution is a separate unbounded wait, and it is the one that hangs.

## The pin has to be `node:https`, not `fetch`

Worth recording because the wrong version compiles and reads correctly.

Checking the host string and then calling `fetch(url)` is not a guard: the client resolves the name again when it opens the socket, and nothing says the second answer matches the first. That is DNS rebinding.
The obvious fix - pass an agent with a custom `lookup` to `fetch` - does nothing, because Node's `fetch` is undici and undici ignores `http.Agent` outright.

So the fetch path is `node:https.request` with a `lookup` that returns one fixed address and ignores the hostname it is handed. That is the only place the promise "the socket went where we checked" can actually be kept. `resolveHost` also refuses a name outright if *any* of its answers is bad, since a name answering with one public and one private address will reach the private one as soon as the order changes.

Related: `agent-web.ts` handles both spellings of an IPv4-mapped IPv6 address (`::ffff:127.0.0.1` and `::ffff:7f00:1`). `new URL()` normalizes the dotted form into the hex one, so a check that only understands dots is inspecting a string the parser already rewrote out from under it - which is the whole of CVE-2026-49857.

## Smaller ones from the same review

- `void win.loadURL(url)` produced a dangling unhandled rejection on every failed navigation, on top of the `did-fail-load` listener that already reported it. `.catch(() => {})` and let the listener answer.
- `executeJavaScript('document.documentElement.outerHTML')` returned an unbounded string. The direct path caps bytes off the socket; the rendered path now slices inside the renderer, before the string crosses to main.
- `capResult` trusted `maxChars`. A `NaN` from a hand-edited settings file makes every comparison false, so every fetch would have come back empty - the one failure mode that looks like an answer.
