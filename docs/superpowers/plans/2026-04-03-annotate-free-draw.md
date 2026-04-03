# Annotate Free Draw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add freehand, line/arrow, shape, and text drawing tools to Fleet's annotation picker alongside the existing element selection workflow, with drawings composited into the final screenshots.

**Architecture:** A full-viewport `<canvas>` element is layered between the page content and the picker UI. Drawing state is an array of `DrawOp` objects; the canvas re-renders all ops on each interaction. At submit time, the canvas is composited onto screenshots client-side before sending to the main process.

**Tech Stack:** Canvas 2D API (within the vanilla JS IIFE in `annotate-picker.ts`), no new dependencies.

---

## File Map

- **Modify:** `src/main/annotate-picker.ts` — the picker IIFE string containing all UI, state, drawing logic, and event handling (Tasks 1-5, 7)
- **Modify:** `src/main/annotate-service.ts` — add `compositeOverlay()` method to composite the canvas drawing layer onto element screenshots using sharp (Task 6)

No changes needed to:
- `src/shared/annotate-types.ts` (no new types needed — drawings are visual-only)
- Any renderer or preload files

Note: `annotate-picker.ts` is a ~2000-line string constant (`PICKER_IIFE_SOURCE`) containing a vanilla JS IIFE. All code changes are edits within that string. The IIFE uses `var`, ES5-style functions, and no modules. All new code must follow this style.

---

### Task 1: Add Drawing State Variables and Z-Index Constant

**Files:**
- Modify: `src/main/annotate-picker.ts:30-100` (Constants and State sections)

- [ ] **Step 1: Add Z_INDEX_CANVAS constant**

After the existing z-index constants (line ~37), add the canvas z-index. It goes between CONNECTORS (2147483643) and MARKERS (2147483644), so we need to shift the existing values to make room:

```javascript
  var Z_INDEX_CONNECTORS = 2147483640;
  var Z_INDEX_CANVAS     = 2147483641;
  var Z_INDEX_MARKERS    = 2147483644;
  var Z_INDEX_HIGHLIGHT  = 2147483645;
  var Z_INDEX_PANEL      = 2147483646;
  var Z_INDEX_TOOLTIP    = 2147483647;
```

Wait — per the spec, stacking order bottom-to-top is: highlight, canvas, badges/markers, notes, panel. So canvas sits above the highlight but below markers:

```javascript
  var Z_INDEX_HIGHLIGHT  = 2147483640;
  var Z_INDEX_CANVAS     = 2147483641;
  var Z_INDEX_CONNECTORS = 2147483643;
  var Z_INDEX_MARKERS    = 2147483644;
  var Z_INDEX_PANEL      = 2147483646;
  var Z_INDEX_TOOLTIP    = 2147483647;
```

- [ ] **Step 2: Add drawing state variables**

After the existing state variables (after `var dragState = null;` around line ~97), add:

```javascript
  // ─────────────────────────────────────────────────────────────────────
  // Drawing State
  // ─────────────────────────────────────────────────────────────────────

  var drawOps = [];           // Array of completed DrawOp objects
  var currentDrawOp = null;   // In-progress operation (during mousedown→mouseup)
  var undoStack = [];         // For redo: popped ops go here
  var activeTool = "pick";    // "pick" | "pen" | "line" | "shape" | "text"
  var activeShape = "rect";   // "rect" | "ellipse" (sub-toggle for shape tool)
  var drawColor = "#ef4444";  // Default red
  var drawWidth = 3;          // Stroke width: 2=thin, 3=medium, 5=thick
  var drawMouseDown = false;  // Whether mouse is currently pressed for drawing
  var canvasEl = null;        // The <canvas> DOM element
  var canvasCtx = null;       // The 2d rendering context
  var textInputEl = null;     // Temporary <input> for text tool

  var DRAW_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];
  var DRAW_WIDTHS = [2, 3, 5]; // thin, medium, thick
  var POINT_MIN_DISTANCE = 3;  // Minimum px between freehand points
```

- [ ] **Step 3: Reset drawing state in resetState()**

In the `resetState()` function (around line ~519), add cleanup for drawing state after the existing resets:

```javascript
    // Reset drawing state
    drawOps = [];
    currentDrawOp = null;
    undoStack = [];
    activeTool = "pick";
    activeShape = "rect";
    drawColor = "#ef4444";
    drawWidth = 3;
    drawMouseDown = false;
    if (textInputEl) { textInputEl.remove(); textInputEl = null; }
    if (canvasEl && canvasCtx) {
      canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    }
```

- [ ] **Step 4: Clean up canvas in deactivate()**

In the `deactivate()` function (around line ~563), add canvas removal after the existing DOM cleanup:

```javascript
    if (canvasEl) canvasEl.remove();
    canvasEl = null;
    canvasCtx = null;
    if (textInputEl) { textInputEl.remove(); textInputEl = null; }
    drawOps = [];
    currentDrawOp = null;
    undoStack = [];
    activeTool = "pick";
    drawMouseDown = false;
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (no type changes — all edits are within the JS string constant)

- [ ] **Step 6: Commit**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): add drawing state variables and z-index for canvas layer"
```

---

### Task 2: Create Canvas Element and Rendering Functions

**Files:**
- Modify: `src/main/annotate-picker.ts` (Styles section ~114, UI Creation section ~603, and new Drawing section)

- [ ] **Step 1: Add canvas CSS styles**

In the STYLES string, after the `.fa-connectors` styles (around line ~231), add:

```css
    #fleet-annotate-canvas {\
      position: fixed;\
      top: 0; left: 0;\
      width: 100%; height: 100%;\
      z-index: " + Z_INDEX_CANVAS + ";\
      pointer-events: none;\
    }\
    #fleet-annotate-canvas.drawing {\
      pointer-events: auto;\
      cursor: crosshair;\
    }\
    #fleet-annotate-canvas.drawing.tool-text {\
      cursor: text;\
    }\
    #fleet-annotate-text-input {\
      position: fixed;\
      z-index: " + Z_INDEX_CANVAS + ";\
      background: transparent;\
      border: 2px dashed var(--fa-accent);\
      border-radius: 3px;\
      color: inherit;\
      font: 16px var(--fa-font-ui);\
      padding: 2px 4px;\
      outline: none;\
      min-width: 100px;\
    }\
```

- [ ] **Step 2: Create canvas setup function**

After the `createNotesContainer()` function (around line ~635), add a `createCanvas()` function:

```javascript
  function createCanvas() {
    canvasEl = document.createElement("canvas");
    canvasEl.id = "fleet-annotate-canvas";
    document.body.appendChild(canvasEl);
    canvasCtx = canvasEl.getContext("2d");
    sizeCanvas();
  }

  function sizeCanvas() {
    if (!canvasEl || !canvasCtx) return;
    var dpr = window.devicePixelRatio || 1;
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvasEl.width = w * dpr;
    canvasEl.height = h * dpr;
    canvasEl.style.width = w + "px";
    canvasEl.style.height = h + "px";
    canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderAllOps();
  }
```

- [ ] **Step 3: Call createCanvas() in activate()**

In the `activate()` function (around line ~503), add `createCanvas();` after `createPanel();`:

```javascript
    createPanel();
    createCanvas();
```

- [ ] **Step 4: Add canvas removal in deactivate()**

Already handled in Task 1 Step 4 — `canvasEl.remove()` is there.

- [ ] **Step 5: Add renderAllOps() function**

Add the core rendering function that clears and redraws all operations:

```javascript
  function renderAllOps() {
    if (!canvasCtx || !canvasEl) return;
    var dpr = window.devicePixelRatio || 1;
    canvasCtx.clearRect(0, 0, canvasEl.width / dpr, canvasEl.height / dpr);

    for (var i = 0; i < drawOps.length; i++) {
      renderOp(canvasCtx, drawOps[i]);
    }
    if (currentDrawOp) {
      renderOp(canvasCtx, currentDrawOp);
    }
  }

  function renderOp(ctx, op) {
    ctx.save();
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = op.width || 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (op.type === "freehand") {
      if (op.points.length < 2) { ctx.restore(); return; }
      ctx.beginPath();
      ctx.moveTo(op.points[0][0], op.points[0][1]);
      for (var j = 1; j < op.points.length; j++) {
        ctx.lineTo(op.points[j][0], op.points[j][1]);
      }
      ctx.stroke();
    } else if (op.type === "line") {
      ctx.beginPath();
      ctx.moveTo(op.start[0], op.start[1]);
      ctx.lineTo(op.end[0], op.end[1]);
      ctx.stroke();
      if (op.arrow) {
        drawArrowHead(ctx, op.start[0], op.start[1], op.end[0], op.end[1], op.width || 3);
      }
    } else if (op.type === "rect") {
      ctx.beginPath();
      ctx.rect(op.origin[0], op.origin[1], op.size[0], op.size[1]);
      ctx.stroke();
    } else if (op.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(
        op.center[0], op.center[1],
        Math.abs(op.radii[0]), Math.abs(op.radii[1]),
        0, 0, Math.PI * 2
      );
      ctx.stroke();
    } else if (op.type === "text") {
      ctx.font = op.fontSize + "px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.fillText(op.content, op.position[0], op.position[1]);
    }
    ctx.restore();
  }

  function drawArrowHead(ctx, fromX, fromY, toX, toY, lineWidth) {
    var headLen = Math.max(10, lineWidth * 4);
    var angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
```

- [ ] **Step 6: Handle canvas in handleResize()**

In the `handleResize()` function (around line ~1354), add canvas resizing at the top:

```javascript
    sizeCanvas();
```

- [ ] **Step 7: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): add canvas element and drawing render functions"
```

---

### Task 3: Add Drawing Tool Toolbar UI

**Files:**
- Modify: `src/main/annotate-picker.ts` (panel HTML ~640, panel styles, and event wiring)

- [ ] **Step 1: Add toolbar CSS styles**

In the STYLES string, after the `.fa-mode-btn.active` styles (around line ~408), add:

```css
    .fa-draw-tools {\
      display: flex;\
      gap: 3px;\
      margin-left: 8px;\
      padding-left: 8px;\
      border-left: 1px solid var(--fa-border-muted);\
    }\
    .fa-tool-btn {\
      background: var(--fa-bg-elevated);\
      border: 1px solid transparent;\
      border-radius: var(--fa-radius);\
      padding: 5px 8px;\
      font-size: 13px;\
      color: var(--fa-fg-muted);\
      cursor: pointer;\
      transition: all 0.15s;\
      line-height: 1;\
    }\
    .fa-tool-btn:hover { background: var(--fa-bg-hover); color: var(--fa-fg); }\
    .fa-tool-btn.active {\
      background: var(--fa-accent-muted);\
      border-color: var(--fa-accent);\
      color: var(--fa-accent);\
    }\
    .fa-color-swatches {\
      display: flex;\
      gap: 3px;\
      margin-left: 8px;\
      padding-left: 8px;\
      border-left: 1px solid var(--fa-border-muted);\
      align-items: center;\
    }\
    .fa-color-swatch {\
      width: 18px;\
      height: 18px;\
      border-radius: 50%;\
      border: 2px solid transparent;\
      cursor: pointer;\
      transition: border-color 0.15s, transform 0.15s;\
    }\
    .fa-color-swatch:hover { transform: scale(1.15); }\
    .fa-color-swatch.active { border-color: var(--fa-fg); }\
    .fa-width-toggle {\
      display: flex;\
      gap: 3px;\
      margin-left: 4px;\
      align-items: center;\
    }\
    .fa-width-btn {\
      background: var(--fa-bg-elevated);\
      border: 1px solid transparent;\
      border-radius: var(--fa-radius);\
      padding: 4px 6px;\
      font-size: 10px;\
      color: var(--fa-fg-muted);\
      cursor: pointer;\
      transition: all 0.15s;\
    }\
    .fa-width-btn:hover { background: var(--fa-bg-hover); }\
    .fa-width-btn.active {\
      background: var(--fa-accent-muted);\
      border-color: var(--fa-accent);\
      color: var(--fa-accent);\
    }\
```

- [ ] **Step 2: Add draw tools to panel HTML**

In the `createPanel()` function, modify the `.fa-toolbar` div content. After the `.fa-mode-toggle` div and before `<div class="fa-spacer"></div>`, insert the drawing tools:

```html
        <div class="fa-draw-tools">\
          <button class="fa-tool-btn" data-tool="pen" title="Pen (P)">\u270E</button>\
          <button class="fa-tool-btn" data-tool="line" title="Line / Arrow (L, hold Shift for arrow)">\u2571</button>\
          <button class="fa-tool-btn" data-tool="shape" title="Shape (S)">\u25A1</button>\
          <button class="fa-tool-btn" data-tool="text" title="Text (T)">T</button>\
        </div>\
        <div class="fa-color-swatches" id="fleet-annotate-colors"></div>\
        <div class="fa-width-toggle" id="fleet-annotate-widths"></div>\
```

- [ ] **Step 3: Add tool switching logic**

After the `createPanel()` function, add the `setActiveTool()` function and toolbar initialization:

```javascript
  function setActiveTool(tool) {
    activeTool = tool;

    // Update pick mode buttons
    var singleBtn = document.getElementById("fleet-annotate-mode-single");
    var multiBtn = document.getElementById("fleet-annotate-mode-multi");
    if (singleBtn) singleBtn.classList.toggle("active", tool === "pick" && !multiSelectMode);
    if (multiBtn) multiBtn.classList.toggle("active", tool === "pick" && multiSelectMode);

    // Update draw tool buttons
    var toolBtns = panelEl ? panelEl.querySelectorAll(".fa-tool-btn") : [];
    for (var i = 0; i < toolBtns.length; i++) {
      toolBtns[i].classList.toggle("active", toolBtns[i].getAttribute("data-tool") === tool);
    }

    // Update canvas pointer-events
    if (canvasEl) {
      if (tool === "pick") {
        canvasEl.classList.remove("drawing", "tool-text");
      } else {
        canvasEl.classList.add("drawing");
        canvasEl.classList.toggle("tool-text", tool === "text");
      }
    }

    // Disable highlight/tooltip when drawing
    if (tool !== "pick") {
      hideHighlight();
      hideTooltip();
    }
  }

  function initDrawToolbar() {
    // Tool buttons
    var toolBtns = panelEl ? panelEl.querySelectorAll(".fa-tool-btn") : [];
    for (var i = 0; i < toolBtns.length; i++) {
      toolBtns[i].addEventListener("click", function (e) {
        var tool = this.getAttribute("data-tool");
        if (activeTool === tool) {
          setActiveTool("pick"); // Toggle off returns to pick
        } else {
          setActiveTool(tool);
        }
      });
    }

    // Color swatches
    var colorsEl = document.getElementById("fleet-annotate-colors");
    if (colorsEl) {
      for (var ci = 0; ci < DRAW_COLORS.length; ci++) {
        var swatch = document.createElement("div");
        swatch.className = "fa-color-swatch" + (DRAW_COLORS[ci] === drawColor ? " active" : "");
        swatch.style.background = DRAW_COLORS[ci];
        swatch.setAttribute("data-color", DRAW_COLORS[ci]);
        swatch.addEventListener("click", function () {
          drawColor = this.getAttribute("data-color");
          var all = colorsEl.querySelectorAll(".fa-color-swatch");
          for (var s = 0; s < all.length; s++) all[s].classList.remove("active");
          this.classList.add("active");
        });
        colorsEl.appendChild(swatch);
      }
    }

    // Width buttons
    var widthsEl = document.getElementById("fleet-annotate-widths");
    var widthLabels = ["S", "M", "L"];
    if (widthsEl) {
      for (var wi = 0; wi < DRAW_WIDTHS.length; wi++) {
        var wBtn = document.createElement("button");
        wBtn.className = "fa-width-btn" + (DRAW_WIDTHS[wi] === drawWidth ? " active" : "");
        wBtn.textContent = widthLabels[wi];
        wBtn.setAttribute("data-width", DRAW_WIDTHS[wi]);
        wBtn.addEventListener("click", function () {
          drawWidth = parseInt(this.getAttribute("data-width"), 10);
          var all = widthsEl.querySelectorAll(".fa-width-btn");
          for (var w = 0; w < all.length; w++) all[w].classList.remove("active");
          this.classList.add("active");
        });
        widthsEl.appendChild(wBtn);
      }
    }
  }
```

- [ ] **Step 4: Wire up initDrawToolbar() in createPanel()**

At the end of `createPanel()`, before the closing `}`, add:

```javascript
    initDrawToolbar();
```

- [ ] **Step 5: Update setMultiMode to set tool to pick**

In `setMultiMode()` (around line ~707), add at the top:

```javascript
    setActiveTool("pick");
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): add drawing tool toolbar with color/width controls"
```

---

### Task 4: Add Drawing Event Handlers

**Files:**
- Modify: `src/main/annotate-picker.ts` (Event Handlers section ~1250)

- [ ] **Step 1: Add canvas mouse event handlers**

Add these functions after the existing event handlers section:

```javascript
  // ─────────────────────────────────────────────────────────────────────
  // Drawing Event Handlers
  // ─────────────────────────────────────────────────────────────────────

  function onCanvasMouseDown(e) {
    if (activeTool === "pick" || !canvasEl) return;

    // Don't start drawing on panel or note cards
    if (e.target.closest("#fleet-annotate-panel") || e.target.closest(".fa-note-card")) return;

    e.preventDefault();
    e.stopPropagation();
    drawMouseDown = true;

    var x = e.clientX;
    var y = e.clientY;

    if (activeTool === "pen") {
      currentDrawOp = { type: "freehand", points: [[x, y]], color: drawColor, width: drawWidth };
    } else if (activeTool === "line") {
      currentDrawOp = { type: "line", start: [x, y], end: [x, y], color: drawColor, width: drawWidth, arrow: e.shiftKey };
    } else if (activeTool === "shape") {
      if (activeShape === "rect") {
        currentDrawOp = { type: "rect", origin: [x, y], size: [0, 0], color: drawColor, width: drawWidth };
      } else {
        currentDrawOp = { type: "ellipse", center: [x, y], radii: [0, 0], color: drawColor, width: drawWidth, dragStart: [x, y] };
      }
    } else if (activeTool === "text") {
      commitTextInput();
      showTextInput(x, y);
      drawMouseDown = false;
      return;
    }
  }

  function onCanvasMouseMove(e) {
    if (!drawMouseDown || !currentDrawOp) return;

    var x = e.clientX;
    var y = e.clientY;

    if (currentDrawOp.type === "freehand") {
      var last = currentDrawOp.points[currentDrawOp.points.length - 1];
      var dx = x - last[0];
      var dy = y - last[1];
      if (dx * dx + dy * dy >= POINT_MIN_DISTANCE * POINT_MIN_DISTANCE) {
        currentDrawOp.points.push([x, y]);
      }
    } else if (currentDrawOp.type === "line") {
      currentDrawOp.end = [x, y];
      currentDrawOp.arrow = e.shiftKey;
    } else if (currentDrawOp.type === "rect") {
      currentDrawOp.size = [x - currentDrawOp.origin[0], y - currentDrawOp.origin[1]];
    } else if (currentDrawOp.type === "ellipse") {
      // dragStart is stored in center initially; compute live center and radii
      var sx = currentDrawOp.dragStart[0];
      var sy = currentDrawOp.dragStart[1];
      currentDrawOp.center = [(sx + x) / 2, (sy + y) / 2];
      currentDrawOp.radii = [Math.abs(x - sx) / 2, Math.abs(y - sy) / 2];
    }

    renderAllOps();
  }

  function onCanvasMouseUp(e) {
    if (!drawMouseDown || !currentDrawOp) {
      drawMouseDown = false;
      return;
    }
    drawMouseDown = false;

    // Clean up transient drag data
    if (currentDrawOp.type === "ellipse") {
      delete currentDrawOp.dragStart;
    }

    // Only commit ops with meaningful content
    var dominated = false;
    if (currentDrawOp.type === "freehand" && currentDrawOp.points.length < 2) dominated = true;
    if (currentDrawOp.type === "line") {
      var ld = Math.hypot(currentDrawOp.end[0] - currentDrawOp.start[0], currentDrawOp.end[1] - currentDrawOp.start[1]);
      if (ld < 3) dominated = true;
    }
    if (currentDrawOp.type === "rect") {
      if (Math.abs(currentDrawOp.size[0]) < 3 && Math.abs(currentDrawOp.size[1]) < 3) dominated = true;
    }
    if (currentDrawOp.type === "ellipse") {
      if (Math.abs(currentDrawOp.radii[0]) < 2 && Math.abs(currentDrawOp.radii[1]) < 2) dominated = true;
    }

    if (!dominated) {
      drawOps.push(currentDrawOp);
      undoStack = []; // New op clears redo stack
    }
    currentDrawOp = null;
    renderAllOps();
  }
```

- [ ] **Step 2: Register canvas event listeners in activate()**

In `activate()`, after the existing `document.addEventListener` calls (around line ~511), add:

```javascript
    // Drawing events — attached to document, filtered by activeTool in handlers
    document.addEventListener("mousedown", onCanvasMouseDown, true);
    document.addEventListener("mousemove", onCanvasMouseMove, true);
    document.addEventListener("mouseup", onCanvasMouseUp, true);
```

- [ ] **Step 3: Remove canvas event listeners in deactivate()**

In `deactivate()`, after the existing `document.removeEventListener` calls (around line ~570), add:

```javascript
    document.removeEventListener("mousedown", onCanvasMouseDown, true);
    document.removeEventListener("mousemove", onCanvasMouseMove, true);
    document.removeEventListener("mouseup", onCanvasMouseUp, true);
```

- [ ] **Step 4: Guard existing onMouseMove for draw mode**

In `onMouseMove()` (around line ~1254), add a guard at the very top:

```javascript
    if (activeTool !== "pick") return;
```

- [ ] **Step 5: Guard existing onClick for draw mode**

In `onClick()` (around line ~1303), add a guard at the very top:

```javascript
    if (activeTool !== "pick") return;
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): add drawing mouse event handlers for pen/line/shape"
```

---

### Task 5: Add Text Tool, Undo/Redo, and Keyboard Shortcuts

**Files:**
- Modify: `src/main/annotate-picker.ts` (Drawing section and onKeyDown)

- [ ] **Step 1: Add text input functions**

Add after the canvas mouse event handlers:

```javascript
  // ─────────────────────────────────────────────────────────────────────
  // Text Tool
  // ─────────────────────────────────────────────────────────────────────

  function showTextInput(x, y) {
    textInputEl = document.createElement("input");
    textInputEl.type = "text";
    textInputEl.id = "fleet-annotate-text-input";
    textInputEl.style.left = x + "px";
    textInputEl.style.top = (y - 12) + "px";
    textInputEl.style.color = drawColor;
    textInputEl.style.fontSize = "16px";
    textInputEl.placeholder = "Type text...";
    document.body.appendChild(textInputEl);
    textInputEl.focus();

    textInputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitTextInput();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (textInputEl) { textInputEl.remove(); textInputEl = null; }
      }
      e.stopPropagation(); // Don't trigger picker shortcuts while typing
    });

    textInputEl.addEventListener("blur", function () {
      // Small delay to avoid race with Enter handler
      setTimeout(function () { commitTextInput(); }, 50);
    });
  }

  function commitTextInput() {
    if (!textInputEl) return;
    var text = textInputEl.value.trim();
    var x = parseInt(textInputEl.style.left, 10);
    var y = parseInt(textInputEl.style.top, 10) + 16; // Offset for baseline
    textInputEl.remove();
    textInputEl = null;

    if (text) {
      drawOps.push({
        type: "text",
        position: [x, y],
        content: text,
        color: drawColor,
        fontSize: 16
      });
      undoStack = [];
      renderAllOps();
    }
  }
```

- [ ] **Step 2: Add undo/redo functions**

```javascript
  // ─────────────────────────────────────────────────────────────────────
  // Undo / Redo
  // ─────────────────────────────────────────────────────────────────────

  function drawUndo() {
    if (drawOps.length === 0) return;
    undoStack.push(drawOps.pop());
    renderAllOps();
  }

  function drawRedo() {
    if (undoStack.length === 0) return;
    drawOps.push(undoStack.pop());
    renderAllOps();
  }
```

- [ ] **Step 3: Add shape sub-toggle**

```javascript
  function toggleShape() {
    activeShape = activeShape === "rect" ? "ellipse" : "rect";
    // Update shape button label
    var shapeBtn = panelEl ? panelEl.querySelector('[data-tool="shape"]') : null;
    if (shapeBtn) {
      shapeBtn.textContent = activeShape === "rect" ? "\u25A1" : "\u25CB";
      shapeBtn.title = activeShape === "rect" ? "Rectangle (S, click again for ellipse)" : "Ellipse (S, click again for rectangle)";
    }
  }
```

- [ ] **Step 4: Update onKeyDown for drawing shortcuts**

Replace the existing `onKeyDown()` function (around line ~1341) with:

```javascript
  function onKeyDown(e) {
    if (!isActive) return;

    // Don't intercept when typing in text inputs
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
      if (e.key === "Escape") {
        e.preventDefault();
        if (textInputEl) { textInputEl.remove(); textInputEl = null; }
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (activeTool !== "pick") {
        setActiveTool("pick");
      } else {
        handleCancel();
      }
      return;
    }

    // Tool shortcuts
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key === "p" || e.key === "P") { e.preventDefault(); setActiveTool(activeTool === "pen" ? "pick" : "pen"); return; }
      if (e.key === "l" || e.key === "L") { e.preventDefault(); setActiveTool(activeTool === "line" ? "pick" : "line"); return; }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        if (activeTool === "shape") {
          toggleShape();
        } else {
          setActiveTool("shape");
        }
        return;
      }
      if (e.key === "t" || e.key === "T") { e.preventDefault(); setActiveTool(activeTool === "text" ? "pick" : "text"); return; }
    }

    // Undo/Redo
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        drawRedo();
      } else {
        drawUndo();
      }
      return;
    }
  }
```

- [ ] **Step 5: Update shape tool button click to toggle sub-shape**

In `initDrawToolbar()`, update the tool button click handler to handle shape toggling:

Replace the tool button click handler with:

```javascript
    for (var i = 0; i < toolBtns.length; i++) {
      toolBtns[i].addEventListener("click", function (e) {
        var tool = this.getAttribute("data-tool");
        if (tool === "shape" && activeTool === "shape") {
          toggleShape();
        } else if (activeTool === tool) {
          setActiveTool("pick");
        } else {
          setActiveTool(tool);
        }
      });
    }
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): add text tool, undo/redo, and keyboard shortcuts"
```

---

### Task 6: Add Screenshot Compositing

**Files:**
- Modify: `src/main/annotate-picker.ts` (handleSubmit function ~1943)

- [ ] **Step 1: Add canvas export function**

Add before `handleSubmit()`:

```javascript
  function getCanvasDataURL() {
    if (!canvasEl || drawOps.length === 0) return null;
    return canvasEl.toDataURL("image/png");
  }
```

- [ ] **Step 2: Modify handleSubmit to include canvas data**

In `handleSubmit()`, after building the `result` object (around line ~1986), add the canvas data URL to the result before calling `deactivate()`:

```javascript
    // Include drawing canvas as data URL for compositing in main process
    var canvasDataURL = getCanvasDataURL();

    deactivate();

    // Attach canvas overlay for main process compositing
    if (canvasDataURL) {
      result.canvasOverlay = canvasDataURL;
    }

    window.fleetAnnotate.submit(result);
```

Remove the existing `deactivate();` and `window.fleetAnnotate.submit(result);` lines that this replaces.

- [ ] **Step 3: Modify annotate-service to composite canvas overlay onto screenshots**

**Files:**
- Modify: `src/main/annotate-service.ts` (handleSubmit method ~222)

In `handleSubmit()`, after the full page screenshot capture (`const fullPng = await this.captureScreenshot();` around line ~263), add compositing logic. Before cropping, composite the canvas overlay onto the full image:

```typescript
          // Composite drawing overlay if present
          let compositedPng = fullPng;
          if (fullPng && (result as any).canvasOverlay) {
            compositedPng = await this.compositeOverlay(fullPng, (result as any).canvasOverlay, viewport);
          }
```

Then use `compositedPng` instead of `fullPng` in the crop that follows.

- [ ] **Step 4: Add compositeOverlay method to AnnotateSession**

In `annotate-service.ts`, add the compositing method:

```typescript
  private async compositeOverlay(
    pagePng: Buffer,
    overlayDataURL: string,
    viewport: { width: number; height: number }
  ): Promise<Buffer> {
    try {
      // Decode the data URL to a buffer
      const base64 = overlayDataURL.replace(/^data:image\/png;base64,/, '');
      const overlayBuffer = Buffer.from(base64, 'base64');
      const overlayImage = nativeImage.createFromBuffer(overlayBuffer);
      const overlaySize = overlayImage.getSize();

      if (overlaySize.width === 0 || overlaySize.height === 0) return pagePng;

      // Use Electron's nativeImage — composite by creating a canvas-like approach
      // Since we're in Node, use the page image and overlay the drawing
      // The simplest approach: use sharp if available, otherwise use nativeImage
      const pageImage = nativeImage.createFromBuffer(pagePng);
      const pageSize = pageImage.getSize();

      // Create a BrowserWindow-less offscreen composite isn't straightforward
      // Instead, use the sharp package for compositing
      const sharp = (await import('sharp')).default;
      const composited = await sharp(pagePng)
        .composite([{
          input: overlayBuffer,
          top: 0,
          left: 0
        }])
        .png()
        .toBuffer();

      return composited;
    } catch (err) {
      log.warn('overlay compositing failed, using plain screenshot', { error: String(err) });
      return pagePng;
    }
  }
```

- [ ] **Step 5: Handle canvas overlay in pre-captured snapshots path**

For the pre-captured snapshot path (where `this.elementSnapshots.get(i)` is used), those snapshots were captured before drawing started, so they need compositing too. In the loop in `handleSubmit()`, after getting `preCapture`:

```typescript
          if (preCapture) {
            // Composite overlay onto pre-capture if drawings exist
            if ((result as any).canvasOverlay) {
              const composited = await this.compositeOverlay(preCapture, (result as any).canvasOverlay, viewport);
              screenshots.push({ index: i + 1, pngBuffer: composited });
            } else {
              screenshots.push({ index: i + 1, pngBuffer: preCapture });
            }
            continue;
          }
```

- [ ] **Step 6: Strip canvasOverlay from persisted result**

Before writing the result JSON, strip the `canvasOverlay` field so it doesn't bloat the stored result:

In `handleSubmit()`, before `if (this.annotationStore)`:

```typescript
      // Don't persist the canvas overlay data URL
      delete (result as any).canvasOverlay;
```

- [ ] **Step 7: Verify sharp is available**

Run: `npm ls sharp`
Expected: sharp is listed as a dependency (it's already used for screenshot cropping in annotate-service)

- [ ] **Step 8: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/annotate-picker.ts src/main/annotate-service.ts
git commit -m "feat(annotate): composite drawing canvas onto screenshots at submit time"
```

---

### Task 7: End-to-End Manual Test and Polish

**Files:**
- Modify: `src/main/annotate-picker.ts` (minor polish)

- [ ] **Step 1: Update hint text in panel header**

In `createPanel()`, update the hint text to mention drawing tools:

```javascript
        <span class="fa-hint">Click elements \u2022 Draw tools: P/L/S/T \u2022 ' + ALT_KEY_LABEL + '+scroll cycles parents \u2022 ESC to close</span>\
```

- [ ] **Step 2: Add cursor feedback for drawing tools**

The canvas already gets `cursor: crosshair` and `cursor: text` from CSS (Task 2). Verify these work for all tool types.

- [ ] **Step 3: Build the project**

Run: `npm run build`
Expected: PASS — build succeeds with no errors

- [ ] **Step 4: Manual test checklist**

Test by launching the app and starting an annotation session:

1. Verify the drawing toolbar appears in the panel with pen/line/shape/text buttons
2. Verify color swatches and width buttons appear
3. Click Pen tool — draw freehand strokes on the page
4. Click Line tool — draw straight lines; hold Shift for arrows
5. Click Shape tool — draw rectangles; click Shape again to toggle to ellipses
6. Click Text tool — click on page, type text, press Enter
7. Press Escape — returns to Pick mode without closing
8. Verify element picking still works in Pick mode (clicks pass through canvas)
9. Press Ctrl+Z to undo, Ctrl+Shift+Z to redo
10. Draw some annotations, pick some elements, click Submit
11. Check the saved screenshots include the drawings composited on top
12. Verify keyboard shortcuts: P, L, S, T toggle tools

- [ ] **Step 5: Commit any polish fixes**

```bash
git add src/main/annotate-picker.ts
git commit -m "feat(annotate): polish drawing toolbar hint text and finalize"
```

---

## Notes for Implementer

- **All picker code is plain ES5 JavaScript inside a template string.** Use `var`, not `let`/`const`. No arrow functions. No template literals inside the IIFE string.
- **String escaping:** The IIFE lives inside backticks. Be careful with `${}` — use string concatenation (`" + variable + "`) instead.
- **The `isPickerElement()` function** checks for `id.startsWith("fleet-annotate-")` and `class.startsWith("fa-")`. New elements must follow this convention so they're excluded from element picking.
- **sharp** is already a dependency used in `annotate-service.ts` for screenshot cropping. The `composite()` API is well-supported.
- **The canvas DPR scaling** is critical for Retina displays. `canvasEl.width = w * dpr` sets the backing store size, `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` scales drawing commands, and `canvasEl.style.width = w + "px"` keeps the CSS size at viewport dimensions.
