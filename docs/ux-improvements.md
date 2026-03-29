# Fleet UX Improvements

Research-backed improvements from Baymard Institute and Nielsen Norman Group (NNG) applied to Fleet's terminal multiplexer UI.

---

## Notification Badges

- [x] **1. Multi-signal badges**: Add shape/size differentiation alongside color. Amber dots pulse gently for permission, red dots are slightly larger for errors, blue dots remain static and small. Addresses color-blindness (WCAG: color must not be sole signal).
- [x] **2. WCAG contrast on dark background**: Test amber/red/blue badge colors against dark sidebar (`bg-neutral-900`) for 3:1 minimum contrast. Use desaturated/lighter tints if needed.
- [x] **3. Active tab indicator distinct from badges**: Ensure the selected tab highlight (background/border) cannot be confused with notification badge colors.

## Active Pane Focus

- [x] **4. Strong focus indicator**: Add 2px border with 3:1 contrast ratio on the focused pane. Use at least two visual cues (border + subtle background shift). Transition must be instant (0ms).

## Split-Pane UX

- [x] **5. Generous resize handle hit areas**: Visual divider can be thin (1px), but draggable area should be 6-8px wide for easy grabbing.

## Sidebar Navigation

- [x] **6. Tab label truncation with tooltip**: Truncate long tab labels with ellipsis, show full name on hover via tooltip. Never cut mid-word.
- [x] **7. Running/idle state indicator per tab**: Each tab shows a compact state indicator (running spinner, idle dash, error icon) that updates in real-time alongside the notification badge.

## Keyboard UX

- [x] **8. Inline shortcut discovery**: Show keyboard shortcuts right-aligned in context menus and tooltips on interactive elements (e.g., "New Tab (Cmd+T)" tooltip on the + button).

## Notification Behavior

- [x] **9. Coalesce burst notifications**: When multiple agents fire alerts within a short window, batch into a single grouped OS notification ("3 agents need attention") instead of N separate alerts.
- [x] **10. Undo close tab**: Show a brief "Undo" toast when closing a tab with a running process, instead of a confirmation dialog.

---

## Sources

### Baymard Institute

- [Highlight the User's Current Scope in Navigation](https://baymard.com/blog/highlight-users-navigation-scope)
- [Core Content Overlooked in Horizontal Tabs](https://baymard.com/blog/avoid-horizontal-tabs)
- [6 Guidelines for Truncation Design](https://baymard.com/blog/truncation-design)
- [Inline Form Validation](https://baymard.com/blog/inline-form-validation)
- [Hover UX: Synchronized Hover & Unified Hit-Areas](https://baymard.com/blog/list-items-hover-and-hit-area)
- ["What's this?" Link & Tooltip](https://baymard.com/blog/whats-this-tooltip)
- [E-Commerce Accessibility](https://baymard.com/research/accessibility)
- [Hotel Search Split View Layout](https://baymard.com/blog/accommodations-split-view)

### Nielsen Norman Group

- [Indicators, Validations, and Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)
- [Push Notification Mistakes](https://www.nngroup.com/articles/push-notification/)
- [Designing for Serial Task Switching](https://www.nngroup.com/articles/serial-task-switching/)
- [Left-Side Vertical Navigation](https://www.nngroup.com/articles/vertical-nav/)
- [Flexibility and Efficiency of Use (Heuristic #7)](https://www.nngroup.com/articles/flexibility-efficiency-heuristic/)
- [Keyboard-Only Navigation](https://www.nngroup.com/articles/keyboard-accessibility/)
- [Dark Mode: Issues to Avoid](https://www.nngroup.com/articles/dark-mode-users-issues/)
- [Visibility of System Status (Heuristic #1)](https://www.nngroup.com/articles/visibility-system-status/)
