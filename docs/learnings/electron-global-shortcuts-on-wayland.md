# Global shortcuts on Wayland, and an electron-store that forgets its defaults

Two surprises from building the teleprompter overlay, both found only by running it.

## `globalShortcut.register` returns `false` for every key on GNOME Wayland

On Ubuntu with GNOME 50.1 (native Wayland, Electron 39.8.2), every teleprompter hotkey came back `false`.
The overlay reported them all as "taken by another app", which was wrong: nothing held them.

A minimal Electron script showed the pattern:

| Session                                                  | `register` result |
| -------------------------------------------------------- | ----------------- |
| Native Wayland                                           | `false`           |
| Native Wayland + `enable-features=GlobalShortcutsPortal` | `false`           |
| `--ozone-platform=x11` (XWayland)                        | `true`            |

- Wayland apps cannot grab keys, so Electron has to ask the `org.freedesktop.portal.GlobalShortcuts` portal.
- Electron 39 only does that with the `GlobalShortcutsPortal` feature on (later Electrons turn it on by default), so Fleet now appends it on Linux in `src/main/index.ts`.
- On GNOME 50 even the portal path fails: xdg-desktop-portal 1.20+ wants a host app to call `org.freedesktop.host.portal.Registry.Register` first, and Chromium never does ([electron#51875](https://github.com/electron/electron/issues/51875), blocked upstream).
- XWayland "works" only in the sense that `register` says `true`: mutter no longer honours XWayland key grabs while another app has focus, so the shortcut is not global.

There is no app-side fix for Electron 39, so the teleprompter tells the truth instead.
On a Wayland session a refused shortcut is reported as `portal` ("Refused by the desktop"), with one explanation in Settings, rather than as `in-use`.
The overlay buttons and command palette still drive everything.

Check again when Electron is upgraded: the downstream write-up at aaddrick/claude-desktop-debian reports GNOME 50 working from Electron 44.

## electron-store `defaults` apply once, at construction

`BoundsStore.load()` read `byDisplay` with a plain `get('byDisplay')` and relied on `defaults: { byDisplay: {} }`.
Deleting `fleet-teleprompter-bounds.json` while Fleet ran made the next open throw `Cannot read properties of undefined (reading '3')`.
electron-store merges `defaults` into the data when the store is constructed, not on every read, so a file removed, emptied or hand-edited afterwards reads back without them.
Pass the fallback at the read site too: `store.get('byDisplay', {})`.
