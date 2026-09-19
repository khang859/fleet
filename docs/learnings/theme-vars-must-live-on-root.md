# Theme variables on the App div left the `:root` aliases dark

## What happened

Under `fleet-light`, inline code in the agent transcript rendered as near-black boxes (#504).
Context menus and other Radix portals were dark too.

## Why

The active theme's `--fleet-*` values were set as an inline `style` on the App root div.
`index.css` declares aliases on `:root`, for example `--muted: var(--fleet-surface-2)`.
A custom property that references another one is resolved on the element that declares it, and descendants inherit the resolved value.
So `:root` resolved `--muted` against the dark defaults, and the App div inherited that dark value even though its own `--fleet-surface-2` was light.
Radix portals mount under `body`, outside the App div, so they never saw the theme at all.

A second, separate cause: `index.css` imported `highlight.js/styles/atom-one-dark.css` for every theme.

## Fix

- `useRootCssVars` in `src/renderer/src/hooks/use-app-theme.ts` sets the theme, accent and glass variables on `document.documentElement`, so the aliases resolve against the live theme and portals inherit it.
- `src/renderer/src/hljs-theme.css` carries the Atom One palette as custom properties, light on `:root` and dark on `.dark`.

## Rule

Set theme variables on the same element that declares the aliases built from them, which here is `:root`.
