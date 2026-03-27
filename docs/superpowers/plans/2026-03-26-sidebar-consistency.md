# Sidebar Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar consistent across all tab types — no auto-collapse, tooltips in collapsed state, workspace access in collapsed state, and unified tab row styling.

**Architecture:** Remove the `isFullScreenTab` / `sidebarManualOpen` system from `App.tsx`. Move sidebar collapse to a user-controlled toggle stored in `App` state. Refactor the mini sidebar in `App.tsx` to include proper grouping, tooltips, and a workspace popover. Unify crew tab rendering in `Sidebar.tsx` to use the same `TabItem` component as file/terminal tabs.

**Tech Stack:** React, TypeScript, Radix UI (Tooltip, Popover), Tailwind CSS, Zustand

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/renderer/src/App.tsx` | Modify | Remove `isFullScreenTab`/`sidebarManualOpen`, add `sidebarCollapsed` state, pass collapse toggle to Sidebar, refactor mini sidebar with tooltips + grouping + workspace popover |
| `src/renderer/src/components/Sidebar.tsx` | Modify | Accept `onCollapse` always (not conditional), unify crew tab rendering to use `TabItem` |
| `src/renderer/src/components/TabItem.tsx` | Modify | Add optional `borderColor` prop for cyan vs blue active borders |

---

### Task 1: Remove auto-collapse and add user-controlled toggle

**Files:**
- Modify: `src/renderer/src/App.tsx:47-84` (remove `sidebarManualOpen`, `isFullScreenTab`, `showSidebar` derived state)
- Modify: `src/renderer/src/App.tsx:370-596` (render section — always show sidebar or mini sidebar based on `sidebarCollapsed`)

- [ ] **Step 1: Replace `sidebarManualOpen` and `isFullScreenTab` with `sidebarCollapsed`**

In `App.tsx`, remove:
```typescript
const [sidebarManualOpen, setSidebarManualOpen] = useState(false);

const isFullScreenTab = useMemo(() => {
  const tab = workspace.tabs.find((t) => t.id === activeTabId);
  return tab?.type === 'star-command' || tab?.type === 'images';
}, [workspace.tabs, activeTabId]);
const showSidebar = !isFullScreenTab || sidebarManualOpen;

// Reset manual override when leaving full-screen tab
useEffect(() => {
  if (!isFullScreenTab) setSidebarManualOpen(false);
}, [isFullScreenTab]);
```

Replace with:
```typescript
const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
```

- [ ] **Step 2: Update the sidebar render condition**

In the render section of `App.tsx`, change:
```typescript
{showSidebar ? (
  <Sidebar
    updateReady={updateReady}
    onCollapse={isFullScreenTab ? () => setSidebarManualOpen(false) : undefined}
  />
) : (
```

To:
```typescript
{!sidebarCollapsed ? (
  <Sidebar
    updateReady={updateReady}
    onCollapse={() => setSidebarCollapsed(true)}
  />
) : (
```

- [ ] **Step 3: Update the mini sidebar expand button**

In the mini sidebar section, change:
```typescript
onClick={() => setSidebarManualOpen(true)}
```
To:
```typescript
onClick={() => setSidebarCollapsed(false)}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no references to removed variables remain)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "refactor: remove auto-collapse, add user-controlled sidebar toggle"
```

---

### Task 2: Add tooltips to collapsed sidebar icons

**Files:**
- Modify: `src/renderer/src/App.tsx:386-491` (mini sidebar section)

- [ ] **Step 1: Add Radix Tooltip import to App.tsx**

Add at the top of `App.tsx`:
```typescript
import * as Tooltip from '@radix-ui/react-tooltip';
```

- [ ] **Step 2: Create a MiniSidebarTooltip helper component**

Add above the `App` function in `App.tsx`:
```typescript
function MiniSidebarTooltip({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="right"
            sideOffset={8}
            className="px-2 py-1 text-xs text-white bg-neutral-800 border border-neutral-700 rounded shadow-lg z-50"
          >
            {label}
            <Tooltip.Arrow className="fill-neutral-800" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
```

- [ ] **Step 3: Wrap the expand button with tooltip**

Change the expand button in the mini sidebar from using `title="Show sidebar"` to:
```tsx
<MiniSidebarTooltip label="Show sidebar">
  <button
    onClick={() => setSidebarCollapsed(false)}
    className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="1" y="2" width="14" height="12" rx="2" />
      <line x1="5.5" y1="2" x2="5.5" y2="14" />
    </svg>
  </button>
</MiniSidebarTooltip>
```

Remove the `title` attribute from the button (tooltip replaces it).

- [ ] **Step 4: Wrap the Images pinned icon with tooltip**

Change the Images icon button — remove `title="Images"` and wrap with:
```tsx
<MiniSidebarTooltip label="Images" key={tab.id}>
  <button
    onClick={() => setActiveTab(tab.id)}
    className={`p-1.5 rounded transition-colors ${
      isImagesActive
        ? 'bg-purple-900/40 ring-1 ring-purple-500/30'
        : 'hover:bg-neutral-800'
    }`}
  >
    {/* existing SVG icon */}
  </button>
</MiniSidebarTooltip>
```

- [ ] **Step 5: Wrap all tab icons with tooltip**

In the tab icons `.map()` section, remove `title={tab.label}` from the button and wrap with:
```tsx
<MiniSidebarTooltip label={tab.label} key={tab.id}>
  <button
    onClick={() => setActiveTab(tab.id)}
    className={`p-1 rounded transition-colors ${
      isActive ? 'bg-neutral-700 ring-1 ring-neutral-600' : 'hover:bg-neutral-800'
    }`}
  >
    {/* existing icon rendering */}
  </button>
</MiniSidebarTooltip>
```

- [ ] **Step 6: Wrap the Settings button with tooltip**

Remove `title="Settings"` and wrap with:
```tsx
<MiniSidebarTooltip label="Settings">
  <button
    onClick={() => document.dispatchEvent(new CustomEvent('fleet:toggle-settings'))}
    className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
  >
    <Settings size={16} />
  </button>
</MiniSidebarTooltip>
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: add Radix tooltips to collapsed sidebar icons"
```

---

### Task 3: Add divider grouping to collapsed sidebar

**Files:**
- Modify: `src/renderer/src/App.tsx:386-491` (mini sidebar section)

- [ ] **Step 1: Add Star Command icon to collapsed sidebar**

Currently the collapsed sidebar skips the Star Command tab entirely. After the expand button and first divider, add the Star Command icon before the Images icon:

```tsx
{/* Star Command pinned icon */}
{workspace.tabs
  .filter((t) => t.type === 'star-command')
  .map((tab) => {
    const isScActive = tab.id === activeTabId;
    return (
      <MiniSidebarTooltip label="Star Command" key={tab.id}>
        <button
          onClick={() => setActiveTab(tab.id)}
          className={`p-1.5 rounded transition-colors ${
            isScActive
              ? 'bg-teal-900/40 ring-1 ring-teal-500/30'
              : 'hover:bg-neutral-800'
          }`}
        >
          <img
            src={ADMIRAL_IMAGES[useStarCommandStore.getState().admiralAvatarState] ?? ADMIRAL_IMAGES.default}
            alt="Star Command"
            width={16}
            height={16}
            style={{ imageRendering: 'pixelated' }}
            className="rounded-sm"
          />
        </button>
      </MiniSidebarTooltip>
    );
  })}
```

Note: Import `useStarCommandStore` and the `ADMIRAL_IMAGES` map will need to be accessible. Since `ADMIRAL_IMAGES` is defined in `Sidebar.tsx`, either move it to a shared location or re-define the admiral image imports in `App.tsx`. The simplest approach: import the admiral default image and use it as a static icon:

```typescript
import admiralDefault from './assets/admiral-default.png';
```

And use `admiralDefault` as the `src` instead of the dynamic lookup (the collapsed sidebar just needs a recognizable icon, not the live avatar state).

- [ ] **Step 2: Restructure dividers to match expanded sidebar sections**

Reorganize the mini sidebar content order to:
1. Expand toggle
2. Divider
3. Star Command icon (pinned)
4. Images icon (pinned)
5. Divider (if pinned items exist)
6. Crew tab icons
7. Divider (if crew tabs exist)
8. File/terminal/image tab icons
9. Spacer (`flex-1`)
10. Workspace icon
11. Settings icon

Replace the current flat structure. The crew tabs are filtered separately:

```tsx
{/* Crew icons */}
{workspace.tabs
  .filter((t) => t.type === 'crew')
  .map((tab) => {
    const isActive = tab.id === activeTabId;
    return (
      <MiniSidebarTooltip label={tab.label} key={tab.id}>
        <button
          onClick={() => setActiveTab(tab.id)}
          className={`p-1 rounded transition-colors ${
            isActive ? 'bg-neutral-700 ring-1 ring-cyan-500/30' : 'hover:bg-neutral-800'
          }`}
        >
          <Avatar type="crew" variant={tab.avatarVariant} size={20} />
        </button>
      </MiniSidebarTooltip>
    );
  })}
{workspace.tabs.some((t) => t.type === 'crew') && (
  <div className="w-6 h-px bg-neutral-800 my-0.5" />
)}
{/* Regular tab icons (file/terminal/image) */}
{workspace.tabs
  .filter((t) => t.type !== 'star-command' && t.type !== 'images' && t.type !== 'crew')
  .map((tab) => {
    const isActive = tab.id === activeTabId;
    return (
      <MiniSidebarTooltip label={tab.label} key={tab.id}>
        <button
          onClick={() => setActiveTab(tab.id)}
          className={`p-1 rounded transition-colors ${
            isActive ? 'bg-neutral-700 ring-1 ring-neutral-600' : 'hover:bg-neutral-800'
          }`}
        >
          {tab.type === 'file' ? (
            <span className={isActive ? 'text-white' : 'text-neutral-500'}>
              {getFileIcon(
                collectPaneLeafs(tab.splitRoot)[0]?.filePath?.split('/').pop() ?? tab.label,
                16
              )}
            </span>
          ) : tab.type === 'image' ? (
            <ImageIcon size={16} className={isActive ? 'text-white' : 'text-neutral-500'} />
          ) : (
            <Terminal size={16} className={isActive ? 'text-white' : 'text-neutral-500'} />
          )}
        </button>
      </MiniSidebarTooltip>
    );
  })}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: add Star Command icon and divider grouping to collapsed sidebar"
```

---

### Task 4: Add workspace popover to collapsed sidebar

**Files:**
- Modify: `src/renderer/src/App.tsx` (mini sidebar section — add workspace icon + Popover before Settings)

- [ ] **Step 1: Add Popover import**

Add at the top of `App.tsx`:
```typescript
import * as Popover from '@radix-ui/react-popover';
```

- [ ] **Step 2: Add workspace popover state and handlers**

Add inside the `App` component, near the other state:
```typescript
const [miniWsOpen, setMiniWsOpen] = useState(false);
const [miniWsList, setMiniWsList] = useState<Array<{ id: string; label: string; tabCount: number }>>([]);

// Load workspaces when popover opens
useEffect(() => {
  if (!miniWsOpen) return;
  void window.fleet.layout.list().then(({ workspaces }) => {
    setMiniWsList(
      workspaces
        .filter((w) => w.id !== workspace.id)
        .map((w) => ({ id: w.id, label: w.label, tabCount: w.tabs.length }))
    );
  });
}, [miniWsOpen, workspace.id]);
```

- [ ] **Step 3: Add workspace switch handler for mini sidebar**

Add inside the `App` component:
```typescript
const handleMiniWsSwitch = useCallback(async (wsId: string) => {
  setMiniWsOpen(false);
  const state = useWorkspaceStore.getState();
  await window.fleet.layout.save({
    workspace: {
      ...state.workspace,
      activeTabId: state.activeTabId ?? undefined,
      activePaneId: state.activePaneId ?? undefined,
      tabs: state.workspace.tabs.map((tab) => ({
        ...tab,
        splitRoot: injectLiveCwd(tab.splitRoot)
      }))
    }
  });
  const freshState = useWorkspaceStore.getState();
  const inMemory = freshState.backgroundWorkspaces.get(wsId);
  if (inMemory) {
    freshState.switchWorkspace(inMemory);
  } else {
    const loaded = await window.fleet.layout.load(wsId);
    if (loaded) useWorkspaceStore.getState().switchWorkspace(loaded);
  }
  setTimeout(() => {
    const s = useWorkspaceStore.getState();
    if (s.workspace.tabs.length === 0) {
      s.addTab(undefined, window.fleet.homeDir);
    }
  }, 0);
}, []);
```

- [ ] **Step 4: Add workspace popover to mini sidebar**

In the mini sidebar, between the `<div className="flex-1" />` spacer and the Settings button, add:

```tsx
{/* Workspace switcher */}
<Popover.Root open={miniWsOpen} onOpenChange={setMiniWsOpen}>
  <MiniSidebarTooltip label={workspace.label}>
    <Popover.Trigger asChild>
      <button className="p-2 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M2 6h12" />
          <path d="M5 3V1.5" />
          <path d="M11 3V1.5" />
        </svg>
      </button>
    </Popover.Trigger>
  </MiniSidebarTooltip>
  <Popover.Portal>
    <Popover.Content
      side="right"
      sideOffset={8}
      className="min-w-[180px] bg-neutral-800 border border-neutral-700 rounded-md shadow-lg py-1 z-50"
    >
      <div className="px-3 py-1.5 text-[10px] text-neutral-500 uppercase tracking-wider">
        Current: {workspace.label}
      </div>
      <div className="h-px bg-neutral-700 my-1" />
      {miniWsList.length > 0 ? (
        miniWsList.map((ws) => (
          <button
            key={ws.id}
            className="w-full px-3 py-1.5 text-sm text-neutral-300 hover:text-white hover:bg-neutral-700 text-left flex items-center justify-between"
            onClick={() => void handleMiniWsSwitch(ws.id)}
          >
            <span className="truncate">{ws.label}</span>
            <span className="text-[10px] text-neutral-600 ml-2">{ws.tabCount} tab{ws.tabCount !== 1 ? 's' : ''}</span>
          </button>
        ))
      ) : (
        <div className="px-3 py-1.5 text-xs text-neutral-600 italic">No other workspaces</div>
      )}
      <Popover.Arrow className="fill-neutral-800" />
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: add workspace switcher popover to collapsed sidebar"
```

---

### Task 5: Make collapse toggle always available in expanded sidebar

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx:280-286` (props type)
- Modify: `src/renderer/src/components/Sidebar.tsx:687-706` (collapse button conditional)

- [ ] **Step 1: Update Sidebar props — make onCollapse required**

Change the Sidebar props type from:
```typescript
export function Sidebar({
  updateReady,
  onCollapse
}: {
  updateReady?: boolean;
  onCollapse?: () => void;
}): React.JSX.Element {
```

To:
```typescript
export function Sidebar({
  updateReady,
  onCollapse
}: {
  updateReady?: boolean;
  onCollapse: () => void;
}): React.JSX.Element {
```

- [ ] **Step 2: Remove the conditional on the collapse button**

Change:
```tsx
{onCollapse && (
  <button
    className="text-neutral-500 hover:text-white px-1 rounded hover:bg-neutral-800 transition-colors"
    onClick={onCollapse}
    title="Collapse sidebar"
  >
```

To (remove the `{onCollapse && (` wrapper and its closing `)}`, keep the button):
```tsx
<button
  className="text-neutral-500 hover:text-white px-1 rounded hover:bg-neutral-800 transition-colors"
  onClick={onCollapse}
  title="Collapse sidebar"
>
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat: make sidebar collapse toggle always available"
```

---

### Task 6: Add borderColor prop to TabItem for crew/file distinction

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx:18-41` (props type)
- Modify: `src/renderer/src/components/TabItem.tsx:129-141` (active border class)

- [ ] **Step 1: Add `activeBorderColor` prop**

In `TabItemProps`, add:
```typescript
/** Tailwind border color class for active state. Defaults to 'border-blue-500'. */
activeBorderColor?: string;
```

- [ ] **Step 2: Destructure the new prop with default**

In the `TabItem` function signature, add:
```typescript
activeBorderColor = 'border-blue-500',
```

- [ ] **Step 3: Use `activeBorderColor` in the className**

Change the active class from:
```typescript
isActive
  ? 'bg-neutral-700 text-white border-l-2 border-blue-500'
  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'
```

To:
```typescript
isActive
  ? `bg-neutral-700 text-white border-l-2 ${activeBorderColor}`
  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TabItem.tsx
git commit -m "feat: add activeBorderColor prop to TabItem"
```

---

### Task 7: Unify crew tab rendering to use TabItem

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx:739-785` (crew tabs section)

- [ ] **Step 1: Replace inline crew tab rendering with TabItem**

Replace the crew tabs section (lines 739-785) from:
```tsx
{workspace.tabs
  .filter((tab) => tab.type === 'crew')
  .map((tab) => {
    const paneIds = collectPaneIds(tab.splitRoot);
    const badge = getTabBadge(paneIds);
    return (
      <div
        key={tab.id}
        data-tab-id={tab.id}
        className={`
        group flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-md text-sm min-h-[44px] transition-colors
        ${
          tab.id === activeTabId
            ? 'bg-neutral-700 text-white border-l-2 border-cyan-500'
            : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 border-l-2 border-transparent'
        }
      `}
        onClick={() => {
          setActiveTab(tab.id);
          for (const paneId of paneIds) {
            useNotificationStore.getState().clearPane(paneId);
            window.fleet.notifications.paneFocused({ paneId });
          }
        }}
      >
        <Avatar type="crew" variant={tab.avatarVariant} size={24} />
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm leading-tight">{tab.label}</div>
        </div>
        {badge && tab.id !== activeTabId && (
          <span
            className={`rounded-full flex-shrink-0 w-2 h-2 ${
              badge === 'error'
                ? 'bg-red-400'
                : badge === 'permission'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-blue-400'
            }`}
          />
        )}
      </div>
    );
  })}
```

With:
```tsx
{workspace.tabs
  .filter((tab) => tab.type === 'crew')
  .map((tab, index) => {
    const paneIds = collectPaneIds(tab.splitRoot);
    return (
      <TabItem
        key={tab.id}
        id={tab.id}
        label={tab.label}
        labelIsCustom={tab.labelIsCustom ?? false}
        cwd={tab.cwd}
        isActive={tab.id === activeTabId}
        badge={getTabBadge(paneIds)}
        icon={<Avatar type="crew" variant={tab.avatarVariant} size={24} />}
        activeBorderColor="border-cyan-500"
        disableReset
        index={index}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        isDragOver={dropTarget?.index === index ? dropTarget.position : null}
        onClick={() => {
          setActiveTab(tab.id);
          for (const paneId of paneIds) {
            useNotificationStore.getState().clearPane(paneId);
            window.fleet.notifications.paneFocused({ paneId });
          }
        }}
        onClose={() => handleCloseTab(tab.id)}
        onRename={(newLabel) => renameTab(tab.id, newLabel)}
        onResetLabel={(liveCwd) => resetTabLabel(tab.id, liveCwd)}
      />
    );
  })}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — full build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "refactor: unify crew tabs to use TabItem component with cyan border"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run full build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Manual verification checklist**

Verify the following behaviors:
1. Sidebar stays visible when switching to Star Command tab
2. Sidebar stays visible when switching to Images tab
3. Collapse toggle button visible on all tabs (not just Star Command/Images)
4. Clicking collapse toggle collapses sidebar to 44px mini bar
5. Collapsed sidebar shows: Star Command icon, Images icon, divider, crew icons, divider, file/terminal icons, spacer, workspace icon, settings icon
6. All collapsed icons show Radix tooltips on hover (right side, with arrow)
7. Workspace icon opens popover with workspace list
8. Clicking a workspace in popover switches to it
9. Crew tabs in expanded sidebar use same row structure as file/terminal tabs
10. Crew tabs show cyan active border, file/terminal tabs show blue active border
11. AdmiralSidebar still appears on right when Star Command is active
