# Copilot Mascot Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current copilot character sprite with a PixelLab-generated "Nebula Pup" alien pet mascot.

**Architecture:** Generate a quadruped dog character via PixelLab MCP, create animations for each copilot state (idle, processing, permission, complete), extract south-facing frames, assemble into a 9-frame horizontal sprite sheet, and swap into the existing copilot assets. No component logic changes needed — frame count and layout match the current sheet exactly.

**Tech Stack:** PixelLab MCP tools, Node.js/sharp for sprite assembly, base64 encoding for the `.ts` asset file.

---

### Task 1: Generate the Nebula Pup Character

**Files:** None yet — this is PixelLab API work.

- [ ] **Step 1: Create the character**

Call `mcp__pixellab__create_character` with:

```
description: "A cute chibi-proportioned alien dog creature with purple and magenta nebula-patterned fur coat, big floppy ears, large expressive eyes, stubby legs, chubby round body, warm orange and gold bioluminescent glow on tail tip ear tips and eyes, extraterrestrial space pet, front facing"
body_type: "quadruped"
template: "dog"
name: "Nebula Pup"
n_directions: 4
size: 128
outline: "single color outline"
shading: "medium shading"
detail: "high detail"
view: "low top-down"
ai_freedom: 800
```

Note: `proportions` is ignored for quadrupeds — chibi style is described in the prompt text.

Record the returned `character_id`.

- [ ] **Step 2: Wait ~3 minutes, then check character status**

Call `mcp__pixellab__get_character` with the character ID and `include_preview: true`.

Verify:
- Job status is complete
- Preview image shows the nebula pup design
- Note the list of available template animations for the dog quadruped

- [ ] **Step 3: User reviews the generated character**

Show the preview to the user. If the design doesn't look right, go back to Step 1 with an adjusted description. If it looks good, proceed to Task 2.

---

### Task 2: Generate Animations

**Files:** None yet — PixelLab API work.

- [ ] **Step 1: Check available template animations**

From the `get_character` response in Task 1 Step 2, identify available quadruped/dog animations. Expected templates include: `walk`, `run`, `idle`, `sleep`, `attack`, `eat`.

Map our states to the best available templates:
- **Idle state** → `sleep` or `idle` template
- **Processing state** → `walk` or `run` template (shows energy/alertness)
- **Complete state** → attempt a template first; if none fits "celebration," use custom animation

- [ ] **Step 2: Generate idle animation**

Call `mcp__pixellab__animate_character` with:

```
character_id: "<character_id>"
template_animation_id: "sleep"  (or "idle" if sleep unavailable)
animation_name: "idle"
directions: ["south"]
```

- [ ] **Step 3: Generate processing animation**

Call `mcp__pixellab__animate_character` with:

```
character_id: "<character_id>"
template_animation_id: "walk"  (or "run" for more energy)
animation_name: "processing"
directions: ["south"]
```

- [ ] **Step 4: Generate complete animation**

Call `mcp__pixellab__animate_character` with:

```
character_id: "<character_id>"
template_animation_id: "idle"  (or best match for happy/bounce)
animation_name: "complete"
directions: ["south"]
```

If no template fits celebration well, use a custom animation instead:

```
character_id: "<character_id>"
action_description: "happy bouncing and wagging tail excitedly"
animation_name: "complete"
directions: ["south"]
confirm_cost: false  (first call to see cost — show user before confirming)
```

- [ ] **Step 5: Generate permission animation**

Try template first:

```
character_id: "<character_id>"
template_animation_id: "eat"  (or closest to "pawing/looking up")
animation_name: "permission"
directions: ["south"]
```

If no template fits, use custom animation:

```
character_id: "<character_id>"
action_description: "looking up with one paw raised, begging"
animation_name: "permission"
directions: ["south"]
confirm_cost: false  (first call to see cost — show user before confirming)
```

- [ ] **Step 6: Wait for all animations to complete (~3-5 minutes each)**

Call `mcp__pixellab__get_character` with `include_preview: true` to check status of all animations. Repeat until all are complete.

- [ ] **Step 7: User reviews all animations**

Show animation previews to the user. If any don't look right, regenerate with adjusted parameters. Once all 4 states are approved, proceed to Task 3.

---

### Task 3: Download and Assemble Sprite Sheet

**Files:**
- Create: `scripts/assemble-copilot-sprites.mjs` (temporary build script)
- Modify: `src/renderer/copilot/src/assets/copilot-sprites.png`

- [ ] **Step 1: Download the character ZIP**

From the `get_character` response, use the ZIP download URL to download all assets:

```bash
curl -o /tmp/nebula-pup.zip "<download_url>"
unzip -o /tmp/nebula-pup.zip -d /tmp/nebula-pup/
```

- [ ] **Step 2: Inspect downloaded frame files**

```bash
ls -la /tmp/nebula-pup/
find /tmp/nebula-pup -name "*.png" | head -30
```

Identify the south-facing animation frames for each animation. PixelLab typically organizes as `<animation_name>/<direction>/<frame_number>.png`.

- [ ] **Step 3: Write the sprite assembly script**

Create `scripts/assemble-copilot-sprites.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Assembles nebula pup animation frames into a single horizontal sprite sheet.
 * Usage: node scripts/assemble-copilot-sprites.mjs <input_dir> <output_png>
 *
 * Expected input_dir structure (from PixelLab ZIP):
 *   idle/south/0.png, idle/south/1.png
 *   processing/south/0.png, processing/south/1.png, processing/south/2.png
 *   permission/south/0.png, permission/south/1.png
 *   complete/south/0.png, complete/south/1.png
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.argv[2];
const outputPng = process.argv[3] || 'copilot-sprites.png';

if (!inputDir) {
  console.error('Usage: node assemble-copilot-sprites.mjs <input_dir> <output_png>');
  process.exit(1);
}

// Animation states in sprite sheet order, with expected frame counts
const states = [
  { name: 'idle', frames: 2 },
  { name: 'processing', frames: 3 },
  { name: 'permission', frames: 2 },
  { name: 'complete', frames: 2 },
];

const FRAME_SIZE = 128;
const TOTAL_FRAMES = 9; // 2+3+2+2

// Collect all frame paths in order
const framePaths = [];
for (const state of states) {
  const stateDir = join(inputDir, state.name, 'south');
  if (!existsSync(stateDir)) {
    console.error(`Missing directory: ${stateDir}`);
    console.error('Available dirs:', readdirSync(inputDir));
    process.exit(1);
  }
  const files = readdirSync(stateDir)
    .filter(f => f.endsWith('.png'))
    .sort((a, b) => parseInt(a) - parseInt(b));

  // Take exactly the number of frames we need (PixelLab may generate more)
  const selected = files.slice(0, state.frames);
  if (selected.length < state.frames) {
    console.error(`Expected ${state.frames} frames for ${state.name}, found ${selected.length}`);
    process.exit(1);
  }
  for (const f of selected) {
    framePaths.push(join(stateDir, f));
  }
}

console.log(`Assembling ${framePaths.length} frames into ${outputPng}...`);

// Use ImageMagick to create horizontal strip
// Each frame is resized/cropped to exactly FRAME_SIZE x FRAME_SIZE
const args = framePaths
  .map(p => `"${p}"`)
  .join(' ');

execSync(
  `convert ${args} -resize ${FRAME_SIZE}x${FRAME_SIZE} +append "${outputPng}"`,
  { stdio: 'inherit' }
);

console.log(`Done: ${TOTAL_FRAMES} frames, ${TOTAL_FRAMES * FRAME_SIZE}x${FRAME_SIZE}px`);
```

- [ ] **Step 4: Run the assembly script**

```bash
node scripts/assemble-copilot-sprites.mjs /tmp/nebula-pup/ src/renderer/copilot/src/assets/copilot-sprites.png
```

Verify the output:

```bash
file src/renderer/copilot/src/assets/copilot-sprites.png
identify src/renderer/copilot/src/assets/copilot-sprites.png
# Expected: PNG 1152x128
```

- [ ] **Step 5: User reviews the assembled sprite sheet**

Open the sprite sheet image and verify all 9 frames look correct in sequence.

---

### Task 4: Update the Base64 Asset and Verify

**Files:**
- Modify: `src/renderer/copilot/src/assets/copilot-sprites.ts`

- [ ] **Step 1: Regenerate the base64 data URI**

```bash
echo "export default 'data:image/png;base64,$(base64 -i src/renderer/copilot/src/assets/copilot-sprites.png | tr -d '\n')';" > src/renderer/copilot/src/assets/copilot-sprites.ts
```

- [ ] **Step 2: Verify the TypeScript file is valid**

```bash
head -c 200 src/renderer/copilot/src/assets/copilot-sprites.ts
# Should start with: export default 'data:image/png;base64,iVBOR...
wc -c src/renderer/copilot/src/assets/copilot-sprites.ts
# Should be a reasonable size (likely smaller than the current 500KB+)
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS — the file exports the same type (a string default export), so `SpaceshipSprite.tsx` should compile without changes.

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected: PASS — no logic changes, just a new sprite sheet.

- [ ] **Step 5: Clean up the assembly script**

```bash
rm scripts/assemble-copilot-sprites.mjs
rm -rf /tmp/nebula-pup /tmp/nebula-pup.zip
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/assets/copilot-sprites.png src/renderer/copilot/src/assets/copilot-sprites.ts
git commit -m "feat(copilot): replace mascot with PixelLab-generated nebula pup

Swap the copilot sprite sheet with a new alien pet mascot:
- Purple/magenta nebula-patterned quadruped with orange/gold glow accents
- Chibi proportions, cute and friendly aesthetic
- Same 9-frame layout: idle(2) processing(3) permission(2) complete(2)
- No component logic changes — identical sprite sheet format"
```
