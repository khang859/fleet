# Copilot window hides macOS Dock icon

## Problem
After adding the copilot overlay window, the Fleet app icon disappeared from the macOS Dock during `npm run dev`. The app was still running but had no Dock presence.

## Root cause
`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` triggers Electron bug [electron/electron#26350](https://github.com/electron/electron/issues/26350). Internally, the `visibleOnFullScreen: true` flag calls `TransformProcessType(&psn, kProcessTransformToUIElementApplication)`, which converts the app into a UI element that doesn't appear in the Dock.

## Fix
1. Remove `{ visibleOnFullScreen: true }` from the copilot window's `setVisibleOnAllWorkspaces` call — the copilot sprite doesn't need fullscreen visibility.
2. Move `app.dock.setIcon()` to after `initCopilot()` so the dock icon is set last.

## Key takeaway
Never use `visibleOnFullScreen: true` with `setVisibleOnAllWorkspaces` unless you're prepared to lose the Dock icon. The `app.dock.hide()`/`app.dock.show()` workaround mentioned in the issue is unreliable.
