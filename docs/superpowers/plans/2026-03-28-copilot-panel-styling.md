# Copilot Panel Styling Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the copilot panel with a CRT pixel-art frame, replace custom elements with shadcn/ui components, and apply Baymard/NNG UX research findings.

**Architecture:** A `CrtFrame` wrapper component composites 7 cropped sprite assets (4 corners, 2 edges, 1 scanline) around panel content. shadcn-style components (Button, Input, ScrollArea, Tooltip, Card, DropdownMenu, Badge) live in `ui/` and replace all custom interactive elements. Baymard/NNG findings are applied via the Badge status variants, focus rings, tooltips, hit-areas, and truncation.

**Tech Stack:** React, TypeScript, Tailwind CSS, Radix UI primitives, class-variance-authority, clsx, tailwind-merge, sharp (one-time asset script)

---

## File Structure

### New Files
- `scripts/crop-crt-sprites.ts` — One-time sharp script to crop/scale CRT assets
- `src/renderer/copilot/src/assets/crt/` — 7 cropped CRT PNGs (output of script)
- `src/renderer/copilot/src/lib/utils.ts` — `cn()` utility
- `src/renderer/copilot/src/components/ui/button.tsx` — shadcn Button
- `src/renderer/copilot/src/components/ui/input.tsx` — shadcn Input
- `src/renderer/copilot/src/components/ui/scroll-area.tsx` — shadcn ScrollArea
- `src/renderer/copilot/src/components/ui/tooltip.tsx` — shadcn Tooltip
- `src/renderer/copilot/src/components/ui/card.tsx` — shadcn Card
- `src/renderer/copilot/src/components/ui/dropdown-menu.tsx` — shadcn DropdownMenu
- `src/renderer/copilot/src/components/ui/badge.tsx` — shadcn Badge with status variants
- `src/renderer/copilot/src/components/CrtFrame.tsx` — CRT bezel wrapper

### Modified Files
- `package.json` — Add `@radix-ui/react-scroll-area`
- `src/renderer/copilot/src/index.css` — Add `.pixelated` utility, focus-visible base styles
- `src/renderer/copilot/src/App.tsx` — Wrap panel in `CrtFrame`
- `src/renderer/copilot/src/components/SessionList.tsx` — shadcn components + Baymard UX
- `src/renderer/copilot/src/components/SessionDetail.tsx` — shadcn components + Baymard UX
- `src/renderer/copilot/src/components/ChatMessage.tsx` — Card for bubbles, Tooltip on tools
- `src/renderer/copilot/src/components/CopilotSettings.tsx` — shadcn components + tooltips

---

### Task 1: Install Dependencies and Crop CRT Assets

**Files:**
- Modify: `package.json`
- Create: `scripts/crop-crt-sprites.ts`
- Create: `src/renderer/copilot/src/assets/crt/` (7 PNGs)

- [ ] **Step 1: Install `@radix-ui/react-scroll-area`**

```bash
npm install @radix-ui/react-scroll-area
```

Expected: Package added to `package.json` dependencies.

- [ ] **Step 2: Create the CRT sprite crop script**

Create `scripts/crop-crt-sprites.ts`:

```typescript
import sharp from 'sharp';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = resolve(root, 'sprites-raw/star-command/chrome');
const dest = resolve(root, 'src/renderer/copilot/src/assets/crt');

if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

interface CropSpec {
  file: string;
  // Content bounds from analysis: { left, top, width, height }
  extract: { left: number; top: number; width: number; height: number };
  resize: { width: number; height: number };
}

const corners: CropSpec[] = [
  {
    file: 'crt-corner-tl.png',
    extract: { left: 45, top: 45, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
  {
    file: 'crt-corner-tr.png',
    extract: { left: 0, top: 45, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
  {
    file: 'crt-corner-bl.png',
    extract: { left: 45, top: 0, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
  {
    file: 'crt-corner-br.png',
    extract: { left: 0, top: 0, width: 467, height: 467 },
    resize: { width: 32, height: 32 },
  },
];

const edges: CropSpec[] = [
  {
    file: 'crt-edge-v.png',
    extract: { left: 127, top: 0, width: 258, height: 512 },
    resize: { width: 16, height: 64 },
  },
  {
    file: 'crt-edge-h.png',
    extract: { left: 0, top: 163, width: 512, height: 145 },
    resize: { width: 64, height: 16 },
  },
];

async function cropAndScale(spec: CropSpec): Promise<void> {
  const input = resolve(src, spec.file);
  const output = resolve(dest, spec.file);
  await sharp(input)
    .extract(spec.extract)
    .resize(spec.resize.width, spec.resize.height, {
      kernel: sharp.kernel.nearest, // Preserve pixel art
    })
    .toFile(output);
  console.log(`✓ ${spec.file} → ${spec.resize.width}x${spec.resize.height}`);
}

async function main(): Promise<void> {
  console.log('Cropping CRT sprites...');
  console.log(`Source: ${src}`);
  console.log(`Destination: ${dest}\n`);

  for (const spec of [...corners, ...edges]) {
    await cropAndScale(spec);
  }

  // Scanline is already 32x32, just copy
  const scanSrc = resolve(src, 'crt-scanline.png');
  const scanDest = resolve(dest, 'crt-scanline.png');
  await sharp(scanSrc).toFile(scanDest);
  console.log('✓ crt-scanline.png → 32x32 (copied)');

  console.log('\nDone! 7 assets written.');
}

main().catch(console.error);
```

- [ ] **Step 3: Run the crop script**

```bash
npx tsx scripts/crop-crt-sprites.ts
```

Expected output:
```
Cropping CRT sprites...
Source: .../sprites-raw/star-command/chrome
Destination: .../src/renderer/copilot/src/assets/crt

✓ crt-corner-tl.png → 32x32
✓ crt-corner-tr.png → 32x32
✓ crt-corner-bl.png → 32x32
✓ crt-corner-br.png → 32x32
✓ crt-edge-v.png → 16x64
✓ crt-edge-h.png → 64x16
✓ crt-scanline.png → 32x32 (copied)

Done! 7 assets written.
```

- [ ] **Step 4: Verify the output files exist**

```bash
ls -la src/renderer/copilot/src/assets/crt/
```

Expected: 7 PNG files listed.

- [ ] **Step 5: Visually verify a cropped corner looks correct**

Open `src/renderer/copilot/src/assets/crt/crt-corner-tl.png` in a viewer. It should show just the rounded corner bezel with no excess transparent padding. If the crop bounds are off, adjust the `extract` values in the script and re-run.

- [ ] **Step 6: Commit**

```bash
git add scripts/crop-crt-sprites.ts src/renderer/copilot/src/assets/crt/ package.json package-lock.json
git commit -m "feat(copilot): add CRT sprite crop script and cropped assets"
```

---

### Task 2: Create `cn()` Utility and CSS Foundation

**Files:**
- Create: `src/renderer/copilot/src/lib/utils.ts`
- Modify: `src/renderer/copilot/src/index.css`

- [ ] **Step 1: Create the `cn()` utility**

Create `src/renderer/copilot/src/lib/utils.ts`:

```typescript
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Add CSS utilities to `index.css`**

Add the following after the existing `@import 'tailwindcss';` line and before the `@keyframes` rules in `src/renderer/copilot/src/index.css`:

```css
/* Pixel art rendering */
.pixelated {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

/* Focus ring base - applied via shadcn components */
*:focus-visible {
  outline: none;
}
```

- [ ] **Step 3: Verify the utility compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/copilot/src/lib/utils.ts src/renderer/copilot/src/index.css
git commit -m "feat(copilot): add cn() utility and CSS foundation"
```

---

### Task 3: Create shadcn UI Components (Button, Input, Card, Badge)

**Files:**
- Create: `src/renderer/copilot/src/components/ui/button.tsx`
- Create: `src/renderer/copilot/src/components/ui/input.tsx`
- Create: `src/renderer/copilot/src/components/ui/card.tsx`
- Create: `src/renderer/copilot/src/components/ui/badge.tsx`

- [ ] **Step 1: Create Button component**

Create `src/renderer/copilot/src/components/ui/button.tsx`:

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900 disabled:pointer-events-none disabled:opacity-30',
  {
    variants: {
      variant: {
        default: 'bg-blue-600/30 text-blue-400 hover:bg-blue-600/50',
        destructive: 'bg-red-600/30 text-red-400 hover:bg-red-600/50',
        success: 'bg-green-600/30 text-green-400 hover:bg-green-600/50',
        outline: 'border border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
        ghost: 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800',
      },
      size: {
        default: 'px-2 py-1',
        sm: 'px-1.5 py-0.5 text-[10px]',
        icon: 'h-6 w-6',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
);
Button.displayName = 'Button';

export { Button, buttonVariants };
```

- [ ] **Step 2: Create Input component**

Create `src/renderer/copilot/src/components/ui/input.tsx`:

```tsx
import * as React from 'react';
import { cn } from '../../lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        'flex w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed',
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export { Input };
```

- [ ] **Step 3: Create Card component**

Create `src/renderer/copilot/src/components/ui/card.tsx`:

```tsx
import * as React from 'react';
import { cn } from '../../lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-lg border border-neutral-700 bg-neutral-800/50', className)}
      {...props}
    />
  )
);
Card.displayName = 'Card';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-2', className)} {...props} />
  )
);
CardContent.displayName = 'CardContent';

export { Card, CardContent };
```

- [ ] **Step 4: Create Badge component with status variants**

Create `src/renderer/copilot/src/components/ui/badge.tsx`:

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center',
  {
    variants: {
      status: {
        idle: 'text-neutral-500',
        running: 'text-blue-400 animate-pulse',
        permission: 'text-amber-400 animate-pulse-amber',
        error: 'text-red-400',
        complete: 'text-green-400',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  }
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

/**
 * Multi-signal status badge per Baymard accessibility guidelines.
 * Uses shape + size + color + animation — color is never the sole signal.
 *
 * idle:       ○  small circle    neutral   static
 * running:    ◎  medium ring     blue      pulse
 * permission: △  large triangle  amber     pulse-amber
 * error:      ■  large square    red       static
 * complete:   ✓  medium check    green     static
 */
function statusIcon(status: BadgeProps['status']): string {
  switch (status) {
    case 'running': return '◎';
    case 'permission': return '△';
    case 'error': return '■';
    case 'complete': return '✓';
    case 'idle':
    default: return '○';
  }
}

function statusSize(status: BadgeProps['status']): string {
  switch (status) {
    case 'permission':
    case 'error':
      return 'text-[10px]';
    case 'running':
    case 'complete':
      return 'text-[8px]';
    case 'idle':
    default:
      return 'text-[6px]';
  }
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, status, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ status }), statusSize(status), className)}
      role="status"
      aria-label={status ?? 'idle'}
      {...props}
    >
      {statusIcon(status)}
    </span>
  )
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
```

- [ ] **Step 5: Verify all four components compile**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/components/ui/
git commit -m "feat(copilot): add shadcn Button, Input, Card, Badge components"
```

---

### Task 4: Create shadcn UI Components (ScrollArea, Tooltip, DropdownMenu)

**Files:**
- Create: `src/renderer/copilot/src/components/ui/scroll-area.tsx`
- Create: `src/renderer/copilot/src/components/ui/tooltip.tsx`
- Create: `src/renderer/copilot/src/components/ui/dropdown-menu.tsx`

- [ ] **Step 1: Create ScrollArea component**

Create `src/renderer/copilot/src/components/ui/scroll-area.tsx`:

```tsx
import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '../../lib/utils';

const ScrollArea = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2 border-l border-l-transparent p-[1px]',
      orientation === 'horizontal' && 'h-2 flex-col border-t border-t-transparent p-[1px]',
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-neutral-700" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
```

- [ ] **Step 2: Create Tooltip component**

Create `src/renderer/copilot/src/components/ui/tooltip.tsx`:

```tsx
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded px-2 py-1 text-[10px] text-neutral-200 bg-neutral-800 border border-neutral-700 shadow-md animate-in fade-in-0 zoom-in-95',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
```

- [ ] **Step 3: Create DropdownMenu component**

Create `src/renderer/copilot/src/components/ui/dropdown-menu.tsx`:

```tsx
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[8rem] overflow-hidden rounded border border-neutral-700 bg-neutral-800 p-1 text-neutral-200 shadow-md',
        className
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center rounded px-2 py-1.5 text-[11px] text-neutral-200 outline-none transition-colors focus:bg-neutral-700 focus:text-neutral-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
```

- [ ] **Step 4: Verify all three components compile**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/copilot/src/components/ui/scroll-area.tsx src/renderer/copilot/src/components/ui/tooltip.tsx src/renderer/copilot/src/components/ui/dropdown-menu.tsx
git commit -m "feat(copilot): add shadcn ScrollArea, Tooltip, DropdownMenu components"
```

---

### Task 5: Create CrtFrame Component

**Files:**
- Create: `src/renderer/copilot/src/components/CrtFrame.tsx`

- [ ] **Step 1: Create the CrtFrame component**

Create `src/renderer/copilot/src/components/CrtFrame.tsx`:

```tsx
import type { ReactNode } from 'react';
import cornerTL from '../assets/crt/crt-corner-tl.png';
import cornerTR from '../assets/crt/crt-corner-tr.png';
import cornerBL from '../assets/crt/crt-corner-bl.png';
import cornerBR from '../assets/crt/crt-corner-br.png';
import edgeH from '../assets/crt/crt-edge-h.png';
import edgeV from '../assets/crt/crt-edge-v.png';
import scanline from '../assets/crt/crt-scanline.png';

const CORNER = 32; // px - matches cropped corner size
const EDGE = 16;   // px - matches cropped edge thickness

export function CrtFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="relative h-full" style={{ background: '#171717' }}>
      {/* Corners */}
      <img
        src={cornerTL}
        alt=""
        className="pixelated absolute top-0 left-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />
      <img
        src={cornerTR}
        alt=""
        className="pixelated absolute top-0 right-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />
      <img
        src={cornerBL}
        alt=""
        className="pixelated absolute bottom-0 left-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />
      <img
        src={cornerBR}
        alt=""
        className="pixelated absolute bottom-0 right-0 pointer-events-none"
        style={{ width: CORNER, height: CORNER }}
        draggable={false}
      />

      {/* Horizontal edges (top and bottom) */}
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          top: 0,
          left: CORNER,
          right: CORNER,
          height: EDGE,
          backgroundImage: `url(${edgeH})`,
          backgroundRepeat: 'repeat-x',
          backgroundSize: `auto ${EDGE}px`,
        }}
      />
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          bottom: 0,
          left: CORNER,
          right: CORNER,
          height: EDGE,
          backgroundImage: `url(${edgeH})`,
          backgroundRepeat: 'repeat-x',
          backgroundSize: `auto ${EDGE}px`,
          transform: 'scaleY(-1)',
        }}
      />

      {/* Vertical edges (left and right) */}
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          left: 0,
          top: CORNER,
          bottom: CORNER,
          width: EDGE,
          backgroundImage: `url(${edgeV})`,
          backgroundRepeat: 'repeat-y',
          backgroundSize: `${EDGE}px auto`,
        }}
      />
      <div
        className="pixelated absolute pointer-events-none"
        style={{
          right: 0,
          top: CORNER,
          bottom: CORNER,
          width: EDGE,
          backgroundImage: `url(${edgeV})`,
          backgroundRepeat: 'repeat-y',
          backgroundSize: `${EDGE}px auto`,
          transform: 'scaleX(-1)',
        }}
      />

      {/* Scanline overlay */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: EDGE,
          left: EDGE,
          right: EDGE,
          bottom: EDGE,
          backgroundImage: `url(${scanline})`,
          backgroundRepeat: 'repeat',
          opacity: 0.05,
        }}
      />

      {/* Content area - padded to sit inside the frame */}
      <div
        className="relative h-full flex flex-col overflow-hidden"
        style={{
          paddingTop: CORNER,
          paddingBottom: EDGE,
          paddingLeft: EDGE,
          paddingRight: EDGE,
        }}
      >
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add PNG module declaration if needed**

Check if the project already has a declaration for `.png` imports. If not, check `src/renderer/copilot/src/env.d.ts` or the existing tsconfig. The copilot renderer likely already handles this via electron-vite's built-in asset handling. Verify:

```bash
npm run typecheck:web
```

If there's a "Cannot find module" error for `.png` imports, create `src/renderer/copilot/src/assets.d.ts`:

```typescript
declare module '*.png' {
  const src: string;
  export default src;
}
```

- [ ] **Step 3: Verify the component compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/copilot/src/components/CrtFrame.tsx
git commit -m "feat(copilot): add CrtFrame bezel wrapper component"
```

---

### Task 6: Integrate CrtFrame into App.tsx

**Files:**
- Modify: `src/renderer/copilot/src/App.tsx`

- [ ] **Step 1: Wrap the expanded panel in CrtFrame**

In `src/renderer/copilot/src/App.tsx`, replace the expanded panel `div` with `CrtFrame`. The current code (lines 59-69):

```tsx
      {expanded && (
        <div
          className={`absolute right-0 left-0 h-[450px] ${
            panelDirection?.vertical === 'up' ? 'bottom-[132px]' : 'top-[132px]'
          }`}
          style={{ zIndex: 10 }}
        >
          {view === 'sessions' && <SessionList />}
          {view === 'detail' && <SessionDetail />}
          {view === 'settings' && <CopilotSettings />}
        </div>
      )}
```

Replace with:

```tsx
      {expanded && (
        <div
          className={`absolute right-0 left-0 h-[450px] ${
            panelDirection?.vertical === 'up' ? 'bottom-[132px]' : 'top-[132px]'
          }`}
          style={{ zIndex: 10 }}
        >
          <CrtFrame>
            {view === 'sessions' && <SessionList />}
            {view === 'detail' && <SessionDetail />}
            {view === 'settings' && <CopilotSettings />}
          </CrtFrame>
        </div>
      )}
```

Add the import at the top:

```tsx
import { CrtFrame } from './components/CrtFrame';
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/App.tsx
git commit -m "feat(copilot): wrap expanded panel in CrtFrame"
```

---

### Task 7: Restyle SessionList with shadcn + Baymard UX

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionList.tsx`

- [ ] **Step 1: Rewrite SessionList**

Replace the entire contents of `src/renderer/copilot/src/components/SessionList.tsx` with:

```tsx
import React from 'react';
import { useCopilotStore } from '../store/copilot-store';
import type { CopilotSession } from '../../../../shared/types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

type BadgeStatus = 'idle' | 'running' | 'permission' | 'error' | 'complete';

function sessionStatus(session: CopilotSession): BadgeStatus {
  if (session.pendingPermissions.length > 0) return 'permission';
  switch (session.phase) {
    case 'processing':
    case 'compacting':
      return 'running';
    case 'waitingForInput':
      return 'idle';
    case 'ended':
      return 'complete';
    default:
      return 'idle';
  }
}

function statusLabel(status: BadgeStatus): string {
  switch (status) {
    case 'running': return 'Processing';
    case 'permission': return 'Waiting for permission';
    case 'error': return 'Error';
    case 'complete': return 'Completed';
    case 'idle':
    default: return 'Idle';
  }
}

function elapsed(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function sortSessions(a: CopilotSession, b: CopilotSession): number {
  const priority = (s: CopilotSession): number => {
    if (s.pendingPermissions.length > 0) return 0;
    if (s.phase === 'processing' || s.phase === 'compacting') return 1;
    if (s.phase === 'waitingForInput') return 2;
    return 3;
  };
  return priority(a) - priority(b);
}

export function SessionList(): React.JSX.Element {
  const sessions = useCopilotStore((s) => s.sessions);
  const selectSession = useCopilotStore((s) => s.selectSession);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const setView = useCopilotStore((s) => s.setView);

  const sorted = [...sessions].sort(sortSessions);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700">
          <span className="text-xs font-medium text-neutral-300">
            Claude Sessions ({sessions.length})
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setView('settings')}>
                ⚙
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>

        {/* Session list */}
        <ScrollArea className="flex-1">
          {sorted.length === 0 ? (
            <div className="flex items-center justify-center h-full text-neutral-500 text-xs px-4 text-center py-8">
              No active Claude Code sessions.
              <br />
              Start a session to see it here.
            </div>
          ) : (
            sorted.map((session) => {
              const status = sessionStatus(session);
              return (
                <div
                  key={session.sessionId}
                  role="button"
                  tabIndex={0}
                  className="flex flex-col px-3 border-b border-neutral-800 cursor-pointer hover:bg-neutral-800/50 transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-inset"
                  style={{ minHeight: 44 }}
                  onClick={() => selectSession(session.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectSession(session.sessionId);
                    }
                  }}
                >
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Multi-signal badge (Baymard: shape+size+color+animation) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge status={status} />
                        </TooltipTrigger>
                        <TooltipContent>{statusLabel(status)}</TooltipContent>
                      </Tooltip>

                      {/* Project name with truncation + tooltip (Baymard) */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-neutral-200 truncate">
                            {session.projectName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{session.projectName}</TooltipContent>
                      </Tooltip>
                    </div>
                    <span className="text-[10px] text-neutral-500 ml-2 shrink-0">
                      {elapsed(session.createdAt)}
                    </span>
                  </div>

                  {/* Inline permission actions */}
                  {session.pendingPermissions.map((perm) => (
                    <div
                      key={perm.toolUseId}
                      className="flex items-center gap-1 pb-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[10px] text-amber-400 truncate flex-1">
                            {perm.tool.toolName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{perm.tool.toolName}</TooltipContent>
                      </Tooltip>
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => respondPermission(perm.toolUseId, 'allow')}
                      >
                        Allow
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => respondPermission(perm.toolUseId, 'deny')}
                      >
                        Deny
                      </Button>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/SessionList.tsx
git commit -m "feat(copilot): restyle SessionList with shadcn + Baymard UX

Uses Badge with multi-signal status, ScrollArea, Tooltip for
truncation, Button variants, 44px hit areas, focus indicators."
```

---

### Task 8: Restyle SessionDetail with shadcn + Baymard UX

**Files:**
- Modify: `src/renderer/copilot/src/components/SessionDetail.tsx`

- [ ] **Step 1: Rewrite SessionDetail**

Replace the entire contents of `src/renderer/copilot/src/components/SessionDetail.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { ChatMessageItem } from './ChatMessage';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Card, CardContent } from './ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Badge } from './ui/badge';

export function SessionDetail(): React.JSX.Element | null {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sessions = useCopilotStore((s) => s.sessions);
  const backToList = useCopilotStore((s) => s.backToList);
  const respondPermission = useCopilotStore((s) => s.respondPermission);
  const chatMessages = useCopilotStore((s) => s.chatMessages);
  const chatLoading = useCopilotStore((s) => s.chatLoading);
  const loadChatHistory = useCopilotStore((s) => s.loadChatHistory);
  const sendMessage = useCopilotStore((s) => s.sendMessage);

  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const session = sessions.find((s) => s.sessionId === selectedSessionId);

  useEffect(() => {
    if (session) {
      loadChatHistory(session.sessionId, session.cwd);
    }
  }, [session?.sessionId, session?.cwd, loadChatHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages.length]);

  const handleSend = async (): Promise<void> => {
    const text = inputText.trim();
    if (!text || !session) return;
    setInputText('');
    await sendMessage(session.sessionId, text);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!session) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col h-full overflow-hidden">
          <div className="flex items-center px-3 py-2 border-b border-neutral-700">
            <Button variant="ghost" size="sm" onClick={backToList}>
              ← Back
            </Button>
          </div>
          <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
            Session not found
          </div>
        </div>
      </TooltipProvider>
    );
  }

  const canSendMessage = session.phase === 'waitingForInput';
  const status = session.pendingPermissions.length > 0
    ? 'permission' as const
    : session.phase === 'processing' || session.phase === 'compacting'
      ? 'running' as const
      : session.phase === 'ended'
        ? 'complete' as const
        : 'idle' as const;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={backToList}>
            ←
          </Button>
          <Badge status={status} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs font-medium text-neutral-200 truncate">
                {session.projectName}
              </span>
            </TooltipTrigger>
            <TooltipContent>{session.projectName}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[9px] text-neutral-500 ml-auto">{session.phase}</span>
            </TooltipTrigger>
            <TooltipContent>Current phase: {session.phase}</TooltipContent>
          </Tooltip>
        </div>

        {/* Pending permissions */}
        {session.pendingPermissions.length > 0 && (
          <div className="px-3 py-2 border-b border-neutral-800">
            <div className="text-[10px] font-medium text-amber-400 mb-1">
              Pending Permissions
            </div>
            {session.pendingPermissions.map((perm) => (
              <Card key={perm.toolUseId} className="mb-2 border-amber-500/20">
                <CardContent>
                  <div className="text-xs text-neutral-200 font-medium">
                    {perm.tool.toolName}
                  </div>
                  {Object.keys(perm.tool.toolInput).length > 0 && (
                    <pre className="mt-1 text-[10px] text-neutral-400 overflow-x-auto max-h-24 overflow-y-auto">
                      {JSON.stringify(perm.tool.toolInput, null, 2)}
                    </pre>
                  )}
                  <div className="flex gap-1 mt-2">
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => respondPermission(perm.toolUseId, 'allow')}
                    >
                      Allow
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => respondPermission(perm.toolUseId, 'deny')}
                    >
                      Deny
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Chat messages */}
        <ScrollArea className="flex-1">
          <div className="px-3 py-2 space-y-2">
            {chatLoading && chatMessages.length === 0 && (
              <div className="text-[10px] text-neutral-500 text-center mt-4">Loading...</div>
            )}
            {!chatLoading && chatMessages.length === 0 && (
              <div className="text-[10px] text-neutral-500 text-center mt-4">No messages yet</div>
            )}
            {chatMessages.map((msg) => (
              <ChatMessageItem key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input bar */}
        <div className="px-3 py-2 border-t border-neutral-800">
          <div className="flex gap-1.5 items-end">
            <Input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!canSendMessage}
              placeholder={
                canSendMessage
                  ? 'Message Claude...'
                  : session.tty
                    ? `Claude is ${session.phase}...`
                    : 'No TTY — cannot send messages'
              }
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!canSendMessage || !inputText.trim()}
            >
              ↑
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/SessionDetail.tsx
git commit -m "feat(copilot): restyle SessionDetail with shadcn + Baymard UX

Uses Button, Input, ScrollArea, Card, Tooltip, Badge components.
Adds focus indicators and truncation tooltips."
```

---

### Task 9: Restyle ChatMessage with Card + Tooltip

**Files:**
- Modify: `src/renderer/copilot/src/components/ChatMessage.tsx`

- [ ] **Step 1: Update ChatMessage to use Card and Tooltip**

Replace the entire contents of `src/renderer/copilot/src/components/ChatMessage.tsx` with:

```tsx
import type { CopilotChatMessage, CopilotMessageBlock } from '../../../../shared/types';
import { useCopilotStore } from '../store/copilot-store';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

function TextBlock({ text }: { text: string }): React.JSX.Element {
  return <div className="text-[11px] text-neutral-200 whitespace-pre-wrap break-words">{text}</div>;
}

const MODE_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree']);

function ToolUseBlock({
  name,
  inputPreview,
}: {
  name: string;
  inputPreview: string;
}): React.JSX.Element {
  if (MODE_TOOLS.has(name)) {
    return (
      <div className="flex items-center gap-1 text-[10px] text-neutral-500 italic px-1">
        <span className="text-purple-400">⟡</span>
        <span>{inputPreview || name}</span>
      </div>
    );
  }

  const displayName = name.startsWith('mcp__')
    ? name.replace(/^mcp__/, '').replace(/__/g, '/')
    : name;

  return (
    <div className="flex items-center gap-1 text-[10px] text-neutral-400 bg-neutral-800/50 rounded px-1.5 py-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-blue-400 font-medium truncate max-w-[120px]">{displayName}</span>
        </TooltipTrigger>
        <TooltipContent>{displayName}</TooltipContent>
      </Tooltip>
      {inputPreview && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate opacity-70 max-w-[140px]">{inputPreview}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{inputPreview}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function AskUserQuestionBlock({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sendMessage = useCopilotStore((s) => s.sendMessage);
  const question = (input['question'] as string) ?? 'Claude needs your input';
  const options = (input['options'] as Array<Record<string, unknown>>) ?? [];

  const handleSelect = (index: number): void => {
    if (!selectedSessionId) return;
    sendMessage(selectedSessionId, String(index + 1));
  };

  const handleGoToTerminal = (): void => {
    if (selectedSessionId) {
      window.copilot.focusTerminal(selectedSessionId);
    }
  };

  return (
    <Card className="border-amber-500/20 bg-amber-500/10">
      <CardContent className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-medium text-amber-400">Question</div>
          <Button variant="outline" size="sm" onClick={handleGoToTerminal}>
            Terminal →
          </Button>
        </div>
        <div className="text-[11px] text-neutral-200">{question}</div>
        {options.length > 0 && (
          <div className="space-y-1 mt-1">
            {options.map((opt, i) => (
              <Button
                key={i}
                variant="outline"
                className="w-full justify-start text-left hover:border-amber-500/30"
                onClick={() => handleSelect(i)}
              >
                <span className="text-[10px] text-amber-400 font-medium mr-1.5">{i + 1}.</span>
                <span className="text-[11px] text-neutral-200">{(opt['label'] as string) ?? ''}</span>
                {opt['description'] && (
                  <span className="text-[10px] text-neutral-500 ml-1">{opt['description'] as string}</span>
                )}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="text-[10px] text-neutral-500">
      <summary className="cursor-pointer hover:text-neutral-400">Thinking...</summary>
      <div className="mt-1 whitespace-pre-wrap break-words pl-2 border-l border-neutral-700">
        {text.slice(0, 500)}{text.length > 500 ? '...' : ''}
      </div>
    </details>
  );
}

function renderToolUse(block: Extract<CopilotMessageBlock, { type: 'tool_use' }>, key: string): React.JSX.Element {
  if (block.name === 'AskUserQuestion' && block.input) {
    return (
      <div key={key} className="max-w-[95%]">
        <AskUserQuestionBlock input={block.input} />
      </div>
    );
  }
  return (
    <div key={key} className="max-w-[90%]">
      <ToolUseBlock name={block.name} inputPreview={block.inputPreview} />
    </div>
  );
}

export function ChatMessageItem({ message }: { message: CopilotChatMessage }): React.JSX.Element {
  const isUser = message.role === 'user';

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}>
      {message.blocks.map((block, i) => {
        const key = `${message.id}-${i}`;
        switch (block.type) {
          case 'text':
            return (
              <Card
                key={key}
                className={`max-w-[90%] ${
                  isUser
                    ? 'bg-blue-600/30 border-blue-600/20 text-blue-100'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-200'
                }`}
              >
                <CardContent className="px-2 py-1">
                  <TextBlock text={block.text} />
                </CardContent>
              </Card>
            );
          case 'tool_use':
            return renderToolUse(block, key);
          case 'thinking':
            return (
              <div key={key} className="max-w-[90%]">
                <ThinkingBlock text={block.text} />
              </div>
            );
          case 'interrupted':
            return (
              <div key={key} className="text-[10px] text-amber-500 italic">
                Interrupted by user
              </div>
            );
        }
      })}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/ChatMessage.tsx
git commit -m "feat(copilot): restyle ChatMessage with Card + Tooltip

Message bubbles use Card, tool names and previews get Tooltip on truncation,
AskUserQuestion uses Card + Button components."
```

---

### Task 10: Restyle CopilotSettings with shadcn + Tooltips

**Files:**
- Modify: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 1: Rewrite CopilotSettings**

Replace the entire contents of `src/renderer/copilot/src/components/CopilotSettings.tsx` with:

```tsx
import { useEffect } from 'react';
import { useCopilotStore } from '../store/copilot-store';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const SYSTEM_SOUNDS = [
  'Pop', 'Ping', 'Tink', 'Glass', 'Blow', 'Bottle', 'Frog',
  'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine', 'Basso',
];

export function CopilotSettings(): React.JSX.Element {
  const settings = useCopilotStore((s) => s.settings);
  const hookInstalled = useCopilotStore((s) => s.hookInstalled);
  const setView = useCopilotStore((s) => s.setView);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const updateSettings = useCopilotStore((s) => s.updateSettings);
  const installHooks = useCopilotStore((s) => s.installHooks);
  const uninstallHooks = useCopilotStore((s) => s.uninstallHooks);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const currentSound = settings?.notificationSound ?? 'Pop';

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
          <Button variant="ghost" size="sm" onClick={() => setView('sessions')}>
            ←
          </Button>
          <span className="text-xs font-medium text-neutral-200">Settings</span>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-3 py-2 space-y-3">
            {/* Notification Sound */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="text-[10px] text-neutral-400 block mb-1 cursor-help">
                    Notification Sound
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Sound played when an agent needs attention
                </TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-xs">
                    {currentSound || 'None'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-48 overflow-y-auto">
                  <DropdownMenuItem onClick={() => updateSettings({ notificationSound: '' })}>
                    None
                  </DropdownMenuItem>
                  {SYSTEM_SOUNDS.map((sound) => (
                    <DropdownMenuItem
                      key={sound}
                      onClick={() => updateSettings({ notificationSound: sound })}
                    >
                      {sound}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Sprite */}
            <div>
              <label className="text-[10px] text-neutral-400 block mb-1">
                Sprite
              </label>
              <div className="text-[10px] text-neutral-500">
                Default spaceship (more sprites coming soon)
              </div>
            </div>

            {/* Claude Code Hooks */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="text-[10px] text-neutral-400 block mb-1 cursor-help">
                    Claude Code Hooks
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Hooks let Fleet monitor Claude Code sessions for permissions and status changes
                </TooltipContent>
              </Tooltip>
              <div className="flex items-center gap-2">
                <Badge status={hookInstalled ? 'complete' : 'error'} />
                <span className="text-xs text-neutral-300">
                  {hookInstalled ? 'Installed' : 'Not installed'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={hookInstalled ? uninstallHooks : installHooks}
                >
                  {hookInstalled ? 'Uninstall' : 'Install'}
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npm run typecheck:web
```

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/CopilotSettings.tsx
git commit -m "feat(copilot): restyle CopilotSettings with shadcn + tooltips

Uses DropdownMenu for sound selector, Badge for hook status,
Tooltip for 'what's this?' on labels, Button + ScrollArea."
```

---

### Task 11: Remove Old Border Styling from Panel Views

**Files:**
- Verify: `src/renderer/copilot/src/components/SessionList.tsx`
- Verify: `src/renderer/copilot/src/components/SessionDetail.tsx`
- Verify: `src/renderer/copilot/src/components/CopilotSettings.tsx`

- [ ] **Step 1: Verify old styling is removed**

The rewrites in Tasks 7-10 already removed the `rounded-lg border border-neutral-700 bg-neutral-900` outer wrappers from each component since `CrtFrame` now provides the frame. Verify by searching:

```bash
cd /Users/khangnguyen/Development/fleet && grep -n "rounded-lg border border-neutral-700" src/renderer/copilot/src/components/SessionList.tsx src/renderer/copilot/src/components/SessionDetail.tsx src/renderer/copilot/src/components/CopilotSettings.tsx
```

Expected: No matches. If any remain, remove them — the `CrtFrame` wrapper in `App.tsx` provides the visual container.

- [ ] **Step 2: Full typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Build the project**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit (if any cleanup was needed)**

```bash
git add -A && git commit -m "fix(copilot): remove residual border styling from panel views"
```

---

### Task 12: Visual Verification and Polish

- [ ] **Step 1: Launch the app and verify the copilot panel**

```bash
npm run dev
```

Open the copilot panel by clicking the spaceship sprite. Verify:
1. CRT frame renders with corners, edges, and subtle scanline
2. Frame images are crisp (pixel-art, not blurry)
3. Content sits inside the frame with correct padding
4. No visual overflow or clipping issues

- [ ] **Step 2: Verify SessionList**
- Sessions show multi-signal badges (shape + color)
- Project names truncate with tooltip on hover
- Rows are at least 44px tall
- Full row is clickable with hover state
- Tab/Enter keyboard navigation works
- Settings gear has tooltip

- [ ] **Step 3: Verify SessionDetail**
- Back button, badge, and project name in header
- Permission blocks render as Cards
- Chat messages render as Cards (user=blue, assistant=neutral)
- Tool names show tooltip on hover
- Input field has focus ring
- ScrollArea works for long chat histories

- [ ] **Step 4: Verify CopilotSettings**
- Back button works
- DropdownMenu opens for sound selection
- Hook status shows Badge (checkmark or square)
- Labels show "what's this?" tooltips on hover

- [ ] **Step 5: Adjust CRT frame dimensions if needed**

If the frame looks too thick or thin, adjust `CORNER` and `EDGE` constants in `CrtFrame.tsx`. If crop bounds were off, re-run the crop script with adjusted values.

- [ ] **Step 6: Final commit if polish changes were needed**

```bash
git add -A && git commit -m "fix(copilot): visual polish for CRT frame and component styling"
```

- [ ] **Step 7: Mark item #7 in ux-improvements.md as complete**

In `docs/ux-improvements.md`, change line 24:
```
- [ ] **7. Running/idle state indicator per tab**
```
to:
```
- [x] **7. Running/idle state indicator per tab**
```

(This is now implemented in the copilot SessionList via the multi-signal Badge.)

```bash
git add docs/ux-improvements.md
git commit -m "docs: mark UX improvement #7 as complete (copilot badges)"
```
