# Annotate List Quick Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add always-visible Copy Path and Delete quick action buttons to each annotation list item.

**Architecture:** Modify the list view section of AnnotateTab.tsx to change each list item from a single `<button>` to a `<div>` with a clickable area and action buttons. Reuses existing `handleCopyPath` and `deleteAnnotation` logic.

**Tech Stack:** React, Lucide icons, Tailwind CSS

---

### Task 1: Add quick action buttons to annotation list items

**Files:**
- Modify: `src/renderer/src/components/AnnotateTab.tsx:239-255`

- [ ] **Step 1: Replace list item `<button>` with `<div>` wrapper and add action buttons**

Replace the list item markup (lines 239-255) with:

```tsx
{annotations.map((ann) => (
  <div
    key={ann.id}
    className="flex items-center gap-2 px-3 py-2.5 hover:bg-neutral-900 border-b border-neutral-800/50 cursor-pointer"
    onClick={() => setSelectedId(ann.id)}
  >
    <div className="flex-1 min-w-0 text-left">
      <div className="text-sm text-neutral-200 truncate">
        {ann.url}
      </div>
      <div className="text-xs text-neutral-500">
        {timeAgo(ann.timestamp)} &middot; {ann.elementCount} element
        {ann.elementCount !== 1 ? 's' : ''}
      </div>
    </div>
    <div className="flex items-center gap-1 flex-shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleCopyPath(ann.id);
        }}
        className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-800"
        title="Copy path"
      >
        <ClipboardCopy size={14} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void deleteAnnotation(ann.id);
        }}
        className="p-1 text-neutral-400 hover:text-red-400 rounded hover:bg-neutral-800"
        title="Delete"
      >
        <Trash2 size={14} />
      </button>
    </div>
  </div>
))}
```

- [ ] **Step 2: Run typecheck to verify no type errors**

Run: `npm run typecheck`
Expected: PASS with no errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS with no errors

- [ ] **Step 4: Manual verification**

1. Open Fleet, navigate to Annotate tab
2. Verify list items show copy and delete icon buttons on the right
3. Click copy button — verify toast "Path copied to clipboard" appears
4. Click delete button — verify annotation is removed from list
5. Click the URL/timestamp area — verify it navigates to detail view
6. Verify buttons don't trigger navigation when clicked

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/AnnotateTab.tsx
git commit -m "feat(annotate): add copy path and delete quick actions to list items"
```
