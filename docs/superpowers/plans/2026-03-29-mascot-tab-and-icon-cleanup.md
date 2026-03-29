# Mascot Tab & Icon Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract mascot selection into its own top-level copilot view and replace all emoji/text-symbol icons with Lucide React components.

**Architecture:** Add `'mascots'` to the `CopilotView` union, create a `MascotPicker` component extracted from `CopilotSettings`, and swap every emoji/text symbol in the copilot panel for a Lucide React icon. No new dependencies needed — `lucide-react` is already installed.

**Tech Stack:** React, TypeScript, Lucide React, Zustand

---

### Task 1: Replace emoji icons in badge.tsx with Lucide React

**Files:**
- Modify: `src/renderer/copilot/src/components/ui/badge.tsx`

- [ ] **Step 1: Update badge.tsx to use Lucide icons**

Replace the `statusIcon` function (which returns emoji strings) with a function returning Lucide React elements, and remove the `statusSize` function (icon sizing will be handled by Lucide's `size` prop).

Replace the entire contents of `src/renderer/copilot/src/components/ui/badge.tsx` with:

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { Circle, CircleDot, Triangle, Square, Check } from 'lucide-react';

const badgeVariants = cva(
  'inline-flex items-center justify-center',
  {
    variants: {
      status: {
        idle: 'text-neutral-500',
        running: 'text-blue-400 animate-pulse',
        permission: 'text-amber-400 animate-pulse-amber',
        error: 'text-red-400',
        complete: 'text-green-400 animate-flash-green',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

function StatusIcon({ status }: { status: BadgeProps['status'] }): React.JSX.Element {
  const size = 10;
  switch (status) {
    case 'running': return <CircleDot size={size} />;
    case 'permission': return <Triangle size={size} />;
    case 'error': return <Square size={size} />;
    case 'complete': return <Check size={size} />;
    case 'idle':
    default: return <Circle size={size} />;
  }
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, status, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ status }), className)}
      role="status"
      aria-label={status ?? 'idle'}
      {...props}
    >
      <StatusIcon status={status} />
    </span>
  )
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors related to badge.tsx

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/ui/badge.tsx
git commit -m "refactor(copilot): replace emoji status icons with Lucide React in badge"
```

---

### Task 2: Replace emoji icons in SessionList, SessionDetail, and CopilotSettings

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionList.tsx`
- Modify: `src/renderer/copilot/src/components/SessionDetail.tsx`
- Modify: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 1: Update SessionList.tsx — replace ⚙ gear emoji with Lucide Settings icon**

Add import at the top of `SessionList.tsx`:

```tsx
import { Settings } from 'lucide-react';
```

Replace the settings button content (line 77):

```tsx
// Old:
⚙
// New:
<Settings size={14} />
```

- [ ] **Step 2: Update SessionDetail.tsx — replace ← and ↑ with Lucide icons**

Add import at the top of `SessionDetail.tsx`:

```tsx
import { ChevronLeft, ArrowUp } from 'lucide-react';
```

Replace all `←` back button text (lines 56 and 82) with:

```tsx
// Old (line 56):
← Back
// New:
<ChevronLeft size={14} />

// Old (line 82):
←
// New:
<ChevronLeft size={14} />
```

Replace the send button `↑` (line 178) with:

```tsx
// Old:
↑
// New:
<ArrowUp size={14} />
```

- [ ] **Step 3: Update CopilotSettings.tsx — replace ← with Lucide ChevronLeft**

Add import at the top of `CopilotSettings.tsx`:

```tsx
import { ChevronLeft } from 'lucide-react';
```

Replace the back button content (line 43):

```tsx
// Old:
←
// New:
<ChevronLeft size={14} />
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/SessionList.tsx src/renderer/copilot/src/components/SessionDetail.tsx src/renderer/copilot/src/components/CopilotSettings.tsx
git commit -m "refactor(copilot): replace emoji icons with Lucide React in session and settings views"
```

---

### Task 3: Add 'mascots' view to store and App routing

**Files:**
- Modify: `src/renderer/copilot/src/store/copilot-store.ts`
- Modify: `src/renderer/copilot/src/App.tsx`

- [ ] **Step 1: Add 'mascots' to CopilotView type in copilot-store.ts**

In `src/renderer/copilot/src/store/copilot-store.ts`, change line 17:

```tsx
// Old:
type CopilotView = 'sessions' | 'detail' | 'settings';
// New:
type CopilotView = 'sessions' | 'detail' | 'settings' | 'mascots';
```

- [ ] **Step 2: Add MascotPicker routing in App.tsx**

In `src/renderer/copilot/src/App.tsx`, add the import:

```tsx
import { MascotPicker } from './components/MascotPicker';
```

Add the routing line after the settings line (after line 70):

```tsx
{view === 'sessions' && <SessionList />}
{view === 'detail' && <SessionDetail />}
{view === 'settings' && <CopilotSettings />}
{view === 'mascots' && <MascotPicker />}
```

- [ ] **Step 3: Verify typecheck passes** (will fail until MascotPicker exists — that's expected, just confirm the store type change is clean)

Run: `npm run typecheck 2>&1 | head -20`
Expected: Only error should be about missing `MascotPicker` module

---

### Task 4: Create MascotPicker component and remove mascot section from settings

**Files:**
- Create: `src/renderer/copilot/src/components/MascotPicker.tsx`
- Modify: `src/renderer/copilot/src/components/CopilotSettings.tsx`
- Modify: `src/renderer/copilot/src/components/SessionList.tsx`

- [ ] **Step 1: Create MascotPicker.tsx**

Create `src/renderer/copilot/src/components/MascotPicker.tsx`:

```tsx
import { useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { ChevronLeft } from 'lucide-react';
import { MASCOT_REGISTRY } from '../../../../shared/mascots';
import { getSpriteSheet } from '../assets/sprite-loader';

export function MascotPicker(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <Button variant="ghost" size="sm" onClick={() => setView('sessions')}>
          <ChevronLeft size={14} />
        </Button>
        <span className="text-xs font-medium text-neutral-200">Mascots</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-3 py-2">
          <div className="flex gap-2">
            {MASCOT_REGISTRY.map((mascot) => {
              const isSelected = (settings?.spriteSheet ?? 'officer') === mascot.id;
              const sheet = getSpriteSheet(mascot.id);
              return (
                <button
                  key={mascot.id}
                  onClick={() => void updateSettings({ spriteSheet: mascot.id })}
                  className={`flex flex-col items-center gap-1 p-1.5 rounded border transition-colors ${
                    isSelected
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-neutral-700 hover:border-neutral-500'
                  }`}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      backgroundImage: `url(${sheet})`,
                      backgroundPosition: `-${mascot.thumbnailFrame * 128 * (48 / 128)}px 0`,
                      backgroundSize: `${128 * 9 * (48 / 128)}px ${48}px`,
                      backgroundRepeat: 'no-repeat',
                      imageRendering: 'pixelated',
                    }}
                  />
                  <span className="text-[10px] text-neutral-300">{mascot.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Remove mascot section from CopilotSettings.tsx**

In `src/renderer/copilot/src/components/CopilotSettings.tsx`:

Remove these two imports that are no longer needed:

```tsx
import { MASCOT_REGISTRY } from '../../../../shared/mascots';
import { getSpriteSheet } from '../assets/sprite-loader';
```

Remove the entire `{/* Mascot */}` block (lines 84-119):

```tsx
            {/* Mascot */}
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">
                Mascot
              </label>
              <div className="flex gap-2">
                {MASCOT_REGISTRY.map((mascot) => {
                  const isSelected = (settings?.spriteSheet ?? 'officer') === mascot.id;
                  const sheet = getSpriteSheet(mascot.id);
                  return (
                    <button
                      key={mascot.id}
                      onClick={() => void updateSettings({ spriteSheet: mascot.id })}
                      className={`flex flex-col items-center gap-1 p-1.5 rounded border transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-neutral-700 hover:border-neutral-500'
                      }`}
                    >
                      <div
                        style={{
                          width: 48,
                          height: 48,
                          backgroundImage: `url(${sheet})`,
                          backgroundPosition: `-${mascot.thumbnailFrame * 128 * (48 / 128)}px 0`,
                          backgroundSize: `${128 * 9 * (48 / 128)}px ${48}px`,
                          backgroundRepeat: 'no-repeat',
                          imageRendering: 'pixelated',
                        }}
                      />
                      <span className="text-[10px] text-neutral-300">{mascot.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
```

- [ ] **Step 3: Add mascot button to SessionList.tsx header**

In `src/renderer/copilot/src/components/SessionList.tsx`, add to imports:

```tsx
import { Settings, PawPrint } from 'lucide-react';
```

Replace the header's right side (the single settings Tooltip block, lines 73-81) with two buttons:

```tsx
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setView('mascots')}>
                  <PawPrint size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mascots</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setView('settings')}>
                  <Settings size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 5: Verify build succeeds**

Run: `npm run build`
Expected: Build completes without errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/components/MascotPicker.tsx src/renderer/copilot/src/components/CopilotSettings.tsx src/renderer/copilot/src/components/SessionList.tsx src/renderer/copilot/src/store/copilot-store.ts src/renderer/copilot/src/App.tsx
git commit -m "feat(copilot): extract mascot selection into dedicated top-level view"
```
