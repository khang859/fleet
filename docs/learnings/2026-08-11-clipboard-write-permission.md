# Every copy button in Fleet was silently doing nothing

Date: 2026-08-11
Found while: adding a "copy the image path" button to the Agent pane

## What happened

The new button called `navigator.clipboard.writeText(path)`, showed its toast, and put nothing on the clipboard.
Not a race, not focus: the promise rejected.

```
navigator.clipboard.writeText('probe')
  → NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied.
```

It rejects the same way from a real click with a user gesture in a focused window, and `document.hasFocus()` is `true` at the time.
Confusingly, `navigator.permissions.query({name: 'clipboard-write'})` answers `granted` regardless - the query and the write do not consult the same thing in Electron.

The button was new; the bug was not.
Thirteen files in `src/renderer` call `navigator.clipboard.writeText`, and every one of them was failing: the copy button on a code block, "Path copied to clipboard" in Annotate, the shell-env value copy, the SSH browser's path copy, terminal copy-on-select.
Most of them show a toast or a tick without waiting for the write to resolve, so the app has been claiming to copy for as long as the handler has been there.

## Why

`src/main/index.ts` sets a deny-everything-else permission handler, added so that `getUserMedia` could be granted for dictation:

```ts
electronSession.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
  callback(permission === 'media' && webContents === mainWindow?.webContents);
});
```

Writing to the clipboard is a permission request in Chromium (`clipboard-sanitized-write`), even from a click.
Without a handler Electron would have allowed it; with this one it is an unrecognised permission, so it is denied.
Deny-by-default is right, but it means every capability the app uses has to be listed, and the clipboard is a capability.

## The fix

Name it:

```ts
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);
```

Sanitized rather than the raw write, since the app only ever puts text on the clipboard.

## What this leaves

Every `writeText` call in the renderer announces success before the write resolves.
That is what turned a denied permission into an invisible bug for months instead of an obvious one on the first click: the toast is drawn from the click, not from the outcome.
Worth moving the announcement into `.then()` wherever it is not already - `CodeBlock` and `MarkdownPane` already do it right.

## The general rule

A deny-by-default permission handler is a list of everything the app is allowed to do, and browsers ask permission for more than the obvious hardware.
When adding one, go through what the renderer already uses rather than only what the feature at hand needs.
And confirm a clipboard write by reading the clipboard back - `pbpaste` after the click - not by watching for the toast, which is drawn whether or not anything happened.
