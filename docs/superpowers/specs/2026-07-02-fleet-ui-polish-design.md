# Fleet UI/UX Polish - Design Spec

Date: 2026-07-02

## Goal

A craft-focused polish pass across Fleet's always-visible surfaces, benchmarked against Linear / Raycast / Warp.
Findings are the synthesis of three independent Fable 5 design reviews (visual, interaction, pane-tools) plus direct code inspection via fleet-drive.

Scope approved by user: all four tiers (bugs, sidebar, settings, chat) plus the pane-tools surface.

Each item lists: problem, location, concrete fix.
Items are grouped by surface and tagged **P0** (reads as broken), **P1** (high craft-per-effort), **P2** (refinement), or **Stretch** (larger redesign, do only if time allows).

## Guardrails

Surgical changes only.
Reuse existing tokens (`--fleet-accent`, `fleet-surface-*`, `fleet-text-*`) and the existing `.focus-ring` utility and shadcn `Select`.
Verify every change with a fleet-drive screenshot before moving on.
No em dashes in any user-facing copy (house style).

---

## A. Broken-looking bugs (do first)

### A1. Focus rings appear on mouse click, app-wide - **P0**
Problem: 60 call-sites use raw `focus:ring` / `focus:outline` / `focus:border`, which show a keyboard-style ring after a plain mouse click (the stuck gold ring on the sidebar Settings button).
There is already a correct `.focus-ring:focus-visible` utility (accent color, keyboard-only) at `src/renderer/src/index.css:346` - it is just bypassed.
Fix: replace the raw `focus:*` ring/outline/border usages with the `focus-ring` class (or `focus-visible:` equivalents). Inputs render identically under focus-visible, so the conversion is safe everywhere.
Location: 60 files under `src/renderer/src` (grep `focus:ring|focus:outline|focus:border`).

### A2. Active session row shifts on select - **P0**
Problem: selecting a session tab drops its leading status circle and shifts the name ~24px left, so selection looks like a layout glitch.
Fix: keep the icon stack and text indent identical in both states; only background, left accent bar, and text color change.
Location: `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/sessions/SessionsTabCard.tsx`.

### A3. Stray teal bar in Search files palette - **P0**
Problem: a ~6px teal horizontal bar sits between the GENERATED IMAGES and RECENT IMAGES sections (orphaned overflow scrollbar or stuck loading bar).
Fix: hide the thumbnail row's horizontal scrollbar (`scrollbar-width: none` / `::-webkit-scrollbar { display:none }`), or ensure any loading bar unmounts once content renders.
Location: Search files palette (file-search overlay component - locate during implementation).

### A4. Broken RECENT IMAGES thumbnails - **P0**
Problem: RECENT IMAGES tiles all render the broken-file placeholder while GENERATED IMAGES load fine - likely a `file://`/CSP path bug.
Fix: fix the thumbnail source path; if a thumbnail truly cannot load, fall back to filename + extension badge, never a repeated broken-file glyph.
Location: same Search files overlay.

### A5. Bottom thumbnail row clipped by footer - **P0**
Problem: the RECENT IMAGES row is cut mid-tile by the keyboard-hint footer.
Fix: add bottom padding to the scroll container equal to footer height, or cap list height to a row boundary.
Location: same Search files overlay.

### A6. Count mismatch: tab "Generated (271)" vs "See all 227" - **P1**
Problem: two counts for what reads as the same set; no other tab carries a count.
Fix: drop the parenthetical count from the tab; keep the count only on "See all". Reconcile the two numbers (confirm whether one counts files and the other images).
Location: same Search files overlay.

### A7. Orphan dot at pane top-right - **P2**
Problem: a lone ~8px circle floats near the pane's top-right, half-lost against the wallpaper, with no label or grouping (it lives in the 36px title-bar drag region).
Fix: determine its purpose (pane-focus/update indicator); give it a labeled home or remove it.
Location: title-bar / pane header (App.tsx region).

---

## B. Sidebar state and consistency

### B1. CHAT tool card looks permanently selected - **P1**
Problem: the CHAT tool card is bright green (border + all-caps green text) even when a terminal pane is focused, so "selected" is a lie; it also does not match the two-line "Sessions" card anatomy.
Fix: one card component - icon tile + sentence-case title + one muted subtitle line ("No conversations" / "3 chats"). Apply the accent (blue) selected treatment only when the tool is actually the active view, matching the active-session-tab style. Reserve all-caps for the MAIN / TOOLS / WORKSPACES section headers only.
Location: `src/renderer/src/components/Sidebar.tsx`.

### B2. Session status dot is decorative - **P1 / Stretch**
Problem: the leading circle always shows the same neutral state; for a multi-agent multiplexer, per-session status is the killer signal.
Fix: make it a real status light - working / needs-input / idle / exited-error - with a tooltip.
Note: depends on a per-session status source. If one exists, P1; if it needs new plumbing, defer to Stretch.
Location: `Sidebar.tsx`, `SessionsTabCard.tsx`.

### B3. Session metadata is uninformative and ambiguous - **P1**
Problem: every row shows an identical relative timestamp ("6m ago"), and two tabs both named "fleet" are indistinguishable; the selected row shows a path while others show time (inconsistent).
Fix: show working directory or `path · branch` as the secondary line (at minimum when names collide); make selected and unselected rows use the same secondary-line rule. Demote the relative timestamp.
Location: `Sidebar.tsx`, `SessionsTabCard.tsx`.

### B4. Persistent close buttons on every row - **P2**
Problem: four always-visible destructive `×` glyphs add clutter and sit in the click path.
Fix: reveal `×` on row hover and on the active row only; fade in ~150ms per the motion convention.
Location: `Sidebar.tsx`, `SessionsTabCard.tsx`.

### B5. "2/5" in the TOOLS header is a cipher - **P2**
Problem: an unlabeled fraction implies progress; the sliders icon's purpose is unclear.
Fix: drop the fraction from the header; show "2 of 5 enabled" inside the tools-config popover; add a tooltip ("Manage tools") to the sliders icon.
Location: `Sidebar.tsx`, `ToolsConfigModal.tsx`.

---

## C. Settings form

### C1. Label to control layout leaves a large gap - **P1**
Problem: `SettingRow` uses `flex justify-between`, pushing a short label to the far left and its control to the far right of the (already 640px-capped) column.
Fix: switch `SettingRow` to a two-column layout (label column + control column) so controls align in a consistent column; standardize control widths (~240px for selects/text inputs, ~96px for numeric inputs, right-aligned numeric values).
Location: `src/renderer/src/components/settings/SettingRow.tsx` (+ callers as needed).

### C2. Native selects mixed with custom controls - **P1**
Problem: App Theme, Terminal Theme, and Default Profile are native `<select>` elements next to custom inputs and the None/Image/Slideshow segmented control - two design systems in one form.
Fix: replace the native selects with the existing shadcn `Select` (same radius, border token, chevron, height).
Location: `settings/GeneralSection.tsx`, `settings/TerminalBackgroundSettings.tsx`.

### C3. Flat hierarchy and a redundant label on the General page - **P2**
Problem: one lone bold "Terminal Background" header floats in an otherwise ungrouped list, and the row under it is labeled just "Background" (self-echo).
Fix: group the page with consistent section headers - Shell / Typography / Appearance / Wallpaper; rename the inner "Background" row (e.g. "Mode") or drop its label and lead with the segmented control. Use the sidebar's caps-label convention for section headers.
Location: `settings/GeneralSection.tsx`.

### C4. Settings nav is a flat 13-item list - **P2**
Problem: app-level, per-tool, and plumbing pages are interleaved with no grouping.
Fix: add group subheaders - Application (General, Notifications, Updates); Tools & Agents (Copilot, Rune, Kanban, Learnings, Annotate, Visualizer, Env Sync); Advanced (Socket API, Diagnostics). (Pi Agent is being removed - do not add it.)
Location: `settings/SettingsNav.tsx`.

### C5. Microcopy - **P2**
Problem: `(auto-detect)` renders at full value brightness with parentheses doing the styling; `Change...` and `System font name...` use three periods; `Custom:` has a stray colon no other label has.
Fix: render "Auto-detect" muted (~55% opacity) until an explicit value is set; use the real ellipsis character; drop the colon.
Location: `settings/GeneralSection.tsx`.

---

## D. Chat empty states

### D1. Main-pane empty state is a bare line - **P1**
Problem: "Start a new chat from the left." floats alone in a ~720px pane and delegates the only action to the sidebar.
Fix: center a proper empty state - a ~32px chat icon at low opacity, a headline ("No conversation selected"), a one-line value subline, and a primary "New chat" button with a ⌘N shortcut hint.
Location: `src/renderer/src/components/chat/ChatView.tsx:60-64`.

### D2. List empty state and zero-state search - **P2**
Problem: "No chats yet." floats under a search box that searches nothing.
Fix: give the list a small icon + one muted line; hide (or disable) the search field when there are zero chats.
Location: `src/renderer/src/components/chat/ConversationList.tsx:271`.

---

## E. Pane tools

Note: the floating toolbar already has Radix tooltips (name + shortcut) and a translucent surface with border; several findings are refinements, not additions.

### E1. Destructive Close sits flush against Search - **P1**
Problem: the benign Search and destructive Close (`×`) icons are adjacent, identical weight, ~28px pitch - one mis-click kills a running session.
Fix: insert a 1px divider + extra gap before Close; give Close a red hover state (`hover:text-red-400 hover:bg-red-500/10`).
Location: `src/renderer/src/components/PaneToolbar.tsx`.

### E2. Toolbar legibility over the wallpaper - **P1**
Problem: at `bg-fleet-surface-2/80` with muted icons over a busy wallpaper, several glyphs disappear.
Fix: raise the surface (e.g. `/90` + `backdrop-blur-md` + slightly stronger border/shadow) and raise idle icon color (muted -> secondary), white on hover. Optionally dim the whole bar when the pane is unfocused.
Location: `PaneToolbar.tsx`.

### E3. Clipboard palette: dead space and lying hints when empty - **P2**
Problem: the empty palette reserves ~380px of blank body below the footer; the footer shows "navigate / paste" hints with zero items; "Clipboard history is empty" + "0 items" restate the same thing.
Fix: shrink palette to fit (input + empty state + footer); in the empty state show only "esc dismiss"; replace the body with an icon + "Nothing copied yet" + one line of how items arrive.
Location: `src/renderer/src/components/ClipboardHistoryOverlay.tsx`.

### E4. Footer hint copy drift - **P2**
Problem: Clipboard says "paste to terminal"; Search files says "paste" for the same action.
Fix: standardize on "paste to terminal"; template the footer bar so copy cannot drift per tool.
Location: palette overlays.

### E5. Env Sync status/action redundancy and dashes - **P2**
Problem: "Local ahead - push" in amber sits next to a "Push" button (word twice); Push is the dialog's primary action but has ghost-gray weight equal to the overflow `...`; em dashes in "Local ahead — push" and "Advanced — this repo overrides".
Fix: status states the state (amber dot + "Local ahead"), button states the action (filled-accent primary "Push"); use plain dashes.
Location: `src/renderer/src/components/settings/EnvSyncSection.tsx` (or the Env Sync modal component - confirm during implementation).

### E6. In-overlay links use default blue, not the app accent - **P2**
Problem: "See all", "Edit", "Create bucket", "+ Scan for env files" are pure blue while the app identity is the chosen accent; blue appears only inside overlays and reads as unstyled default-link color.
Fix: recolor in-overlay links/actions to the app accent token.
Location: Search files overlay, Env Sync modal.

### E7. Toolbar overflow menu + cross-overlay chrome unification - **Stretch**
Problem: 12 peer icons exceed the recognition limit; the cmdk palette and the titled dialog differ in width, top-anchor, scrim opacity, and footer presence.
Fix (defer): fold the long tail of toolbar actions into a labeled `...` overflow menu, keeping ~5 daily-drivers visible; unify overlay width (~600px), radius, border, and scrim, and give the Env Sync dialog the same top anchor and a footer hint bar.
Location: `PaneToolbar.tsx`, overlay/dialog components.

---

## Execution plan

Phase 1 (P0 + high-confidence P1), verified surface by surface with screenshots:
A1, A2, A3, A4, A5, A6 -> B1, B3, B4 -> C1, C2, C5 -> D1 -> E1, E2.

Phase 2 (P2 refinements): B5, C3, C4, D2, E3, E4, E5, E6, A7.

Stretch (only if time): B2 (status light), E7 (overflow menu + chrome unification).

Each phase ends with typecheck + lint (`npm run typecheck`, `npm run lint`) and a fleet-drive visual pass.
