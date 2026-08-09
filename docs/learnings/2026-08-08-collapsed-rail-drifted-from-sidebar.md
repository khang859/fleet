# The collapsed rail is a second, hand-maintained copy of the sidebar

Reported as "the sidebar when collapsed, the agents section and tabs isn't showing as separate".
In the expanded sidebar, agent panes are a pinned section of their own with a header and a top border (`Sidebar.tsx`), and the scrolling tab list filters `type !== 'agent'` so they aren't listed twice.
The collapsed rail in `src/renderer/src/App.tsx` did none of that: it mapped `workspace.tabs` with only `settings`/`annotate`/`sessions` filtered out, so an agent's Bot icon landed in the middle of the terminal icons with nothing between them.

## Cause

The rail is not a narrow rendering of `Sidebar` - it is an independent block of JSX inside `App.tsx` that re-implements the same list from the same store.
Every rule the sidebar learned had to be copied by hand, and three of them never were:

| Rule | Expanded sidebar | Collapsed rail (before) |
| --- | --- | --- |
| Agents are their own section | pinned block, own border | mixed into the tab run |
| `markdown` counts as a file | file icon | terminal icon |
| `ssh-browser` | `<Server />` | terminal icon |

Nobody noticed because the two views are never on screen at the same time, so the drift is invisible unless you toggle and compare.

## Fix

Give the rail the sidebar's own section order - tabs, spacer, agents, tools, workspace/settings - and factor the per-tab button into one `MiniTabButton` that carries the sidebar's icon vocabulary, so the icon rules live in a single place per view instead of once per call site.
The section seams became `RailDivider` (`w-full h-px bg-fleet-border-strong`); the old `w-6` faint rule was too short and too low-contrast to read as a boundary at 44px wide.

The rail was also missing status entirely - an agent waiting on a permission prompt was invisible while collapsed.
Rather than reimplement the sidebar's "activity glyph unless a raw notification outranks it" rule a second time (which is how the drift above happened in the first place), that decision moved into `TabStatusIndicator`, which both the sidebar row and the rail now render.
The rail passes positioning through `className` and nothing else, so there is no second copy of the rule to fall behind.

## Takeaway

When adding a tab type or a section to `Sidebar.tsx`, open the collapsed rail in `App.tsx` in the same change - it renders the same tabs and will silently keep the old behavior.
Verify by collapsing the sidebar in the dev window (`npm run drive -- screenshot --selector 'div.w-11'`), not by reading the JSX.
