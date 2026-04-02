# Annotate Special Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Annotate tab a visually differentiated, non-closable, non-draggable special tab card in the sidebar — matching the Images tab treatment — and document `fleet annotate` in the injected skill doc.

**Architecture:** Add an `AnnotateTabCard` component to `Sidebar.tsx` following the `ImagesTabCard` pattern with teal accent colors. Filter annotate from regular tabs. Add `fleet annotate` docs to the skill file.

**Tech Stack:** React, TypeScript, inline styles (matching existing pattern)

---

### Task 1: Add `AnnotateTabCard` component to Sidebar

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx` (add component after `ImagesTabCard` definition, ~line 296)

- [ ] **Step 1: Add the `AnnotateTabCard` component**

Insert this component right after the `ImagesTabCard` closing brace (after line 296 in `Sidebar.tsx`):

```tsx
function AnnotateTabCard({
  isActive,
  onClick
}: {
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-md overflow-hidden relative transition-all"
      style={{
        background: isActive ? '#0a1a1a' : 'rgba(10,26,26,0.4)',
        border: isActive ? '1px solid rgba(45,212,191,0.35)' : '1px solid rgba(255,255,255,0.05)',
        boxShadow: isActive
          ? '0 0 10px rgba(45,212,191,0.15), inset 0 0 20px rgba(45,212,191,0.03)'
          : 'none'
      }}
    >
      {/* Subtle noise overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10 opacity-[0.03]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(transparent 0px, transparent 1px, rgba(255,255,255,0.15) 1px, rgba(255,255,255,0.15) 2px)',
          backgroundSize: '100% 2px'
        }}
      />

      <div className="relative z-20 flex items-center gap-2.5 px-2.5 py-2">
        {/* Icon */}
        <div className="flex-shrink-0 w-8 h-8 rounded-sm overflow-hidden bg-neutral-800/50 flex items-center justify-center">
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke={isActive ? 'rgb(94,234,212)' : 'rgba(94,234,212,0.4)'}
            strokeWidth="1.5"
          >
            <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </div>

        {/* Label */}
        <div className="flex-1 min-w-0">
          <div
            className="font-mono uppercase tracking-widest leading-none"
            style={{
              fontSize: '9px',
              color: isActive ? 'rgb(94,234,212)' : 'rgba(94,234,212,0.5)'
            }}
          >
            Annotate
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(annotate): add AnnotateTabCard component"
```

---

### Task 2: Render `AnnotateTabCard` in sidebar and filter from regular tabs

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx` (~lines 999-1017)

- [ ] **Step 1: Add AnnotateTabCard rendering after ImagesTabCard**

Find this block (~line 1008):

```tsx
            ))}
          {workspace.tabs.filter((t) => t.type === 'images').length > 0 && (
            <div className="h-px bg-neutral-800 mx-1 my-1" />
          )}
```

Replace with:

```tsx
            ))}
          {/* Annotate tab (pinned, not closeable) */}
          {workspace.tabs
            .filter((tab) => tab.type === 'annotate')
            .map((tab) => (
              <AnnotateTabCard
                key={tab.id}
                isActive={tab.id === activeTabId}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
          {(workspace.tabs.some((t) => t.type === 'images' || t.type === 'annotate')) && (
            <div className="h-px bg-neutral-800 mx-1 my-1" />
          )}
```

- [ ] **Step 2: Filter annotate out of regularTabs**

Find (~line 1013-1017):

```tsx
            const regularTabs = workspace.tabs.filter(
              (t) =>
                t.type !== 'images' &&
                t.type !== 'settings'
            );
```

Replace with:

```tsx
            const regularTabs = workspace.tabs.filter(
              (t) =>
                t.type !== 'images' &&
                t.type !== 'settings' &&
                t.type !== 'annotate'
            );
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(annotate): render as special card in sidebar, exclude from regular tabs"
```

---

### Task 3: Document `fleet annotate` in skill doc

**Files:**
- Modify: `resources/skills/fleet.md` (insert between `fleet open` section and `fleet images` section)

- [ ] **Step 1: Add fleet annotate documentation**

Find the line (line 26):

```markdown
## fleet images
```

Insert before it:

```markdown
## fleet annotate

Visually annotate web page elements for AI agents to act on. Opens a browser window where you can click elements, add comments, and capture screenshots. Results are written to a JSON file.

```bash
fleet annotate [url]
fleet annotate [url] --timeout <seconds>
```

- `[url]` — URL to annotate. If omitted, opens a blank page.
- `--timeout <seconds>` — Max seconds to wait for annotation (default: 300).

### Examples

```bash
fleet annotate https://localhost:3000
fleet annotate https://example.com --timeout 600
fleet annotate
```

```

- [ ] **Step 2: Commit**

```bash
git add resources/skills/fleet.md
git commit -m "docs: add fleet annotate to injected skill doc"
```
