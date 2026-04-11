# Global Custom Scrollbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace native Chromium scrollbars with a subtle, always-visible cyan-themed scrollbar across the entire app.

**Architecture:** Replace the unused `.scrollbar-sc` scoped class with universal `*::-webkit-scrollbar` rules in the global CSS file. No component changes needed.

**Tech Stack:** CSS (webkit scrollbar pseudo-elements), Electron/Chromium

---

### Task 1: Replace scoped scrollbar class with universal scrollbar rules

**Files:**
- Modify: `src/renderer/src/index.css:55-68`

- [ ] **Step 1: Replace the `.scrollbar-sc` class with universal scrollbar rules**

In `src/renderer/src/index.css`, replace lines 55-68:

```css
/* Custom scrollbar — dark sci-fi theme */
.scrollbar-sc::-webkit-scrollbar {
  width: 6px;
}
.scrollbar-sc::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-sc::-webkit-scrollbar-thumb {
  background: #2dd4bf33;
  border-radius: 3px;
}
.scrollbar-sc::-webkit-scrollbar-thumb:hover {
  background: #2dd4bf66;
}
```

With:

```css
/* Global scrollbar — dark sci-fi theme */
*::-webkit-scrollbar {
  width: 6px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: #2dd4bf33;
  border-radius: 3px;
}
*::-webkit-scrollbar-thumb:hover {
  background: #2dd4bf66;
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`

Check these scrollable areas:
1. Telescope modal (Cmd+K) — results list and preview panel
2. Markdown preview pane — scroll long content
3. Settings panel — scroll if content overflows
4. Any file browser / browse mode with many items

Expected: Thin cyan scrollbar thumb visible in all scrollable areas. Thumb brightens on hover. No thick native scrollbar anywhere.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/index.css
git commit -m "fix(ui): replace scoped scrollbar class with global custom scrollbar"
```
