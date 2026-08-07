# Learnings: invented Tailwind token `bg-fleet-surface-1` (2026-08-04)

## Non-existent `fleet-*` color classes fail silently

**Problem:** The first version of `AgentPane` used `bg-fleet-surface-1`.
There is no such token, so Tailwind generated nothing and the pane rendered with whatever background sat behind it.
Nothing errors - not typecheck, not lint, not the build - so the mistake is invisible until someone compares the pixels.

**Root cause:** The surface ramp in `src/renderer/src/index.css` is `--fleet-surface`, `--fleet-surface-2`, `--fleet-surface-3`.
There is no `-1` suffix; the base surface is unnumbered, and the page background is `--fleet-bg`.

**Fix:** Use `bg-fleet-bg` (or `bg-fleet-surface`).
Before writing a `fleet-*` utility class, confirm the token exists:

```bash
grep -nE "^\s*--color-fleet[a-z0-9-]*:" src/renderer/src/index.css
```

**Note:** `src/renderer/src/components/chat/PermissionBar.tsx` carries the same dead class and is worth fixing when that file is next touched.
