/**
 * Fleet Annotate - Element Picker UI
 *
 * Ported from pi-annotate content.js (v0.3.5).
 * Returns picker JavaScript as a string for injection into a BrowserWindow
 * via webContents.executeJavaScript().
 *
 * The picker code is plain JavaScript wrapped in an IIFE string. It runs
 * in the web page context with access to `window.fleetAnnotate` (exposed
 * by preload script).
 */

// NOTE: The IIFE source is stored as a string constant to avoid TypeScript
// trying to type-check what is intentionally plain browser JavaScript.
// The backtick-delimited string below IS the picker — edit it as JS.

export function getPickerSource(): string {
  return PICKER_IIFE_SOURCE;
}

/* eslint-disable no-useless-escape */
const PICKER_IIFE_SOURCE = `(function() {
  // Prevent double-injection
  if (window.__fleetAnnotate_loaded) return;
  window.__fleetAnnotate_loaded = true;

  // ─────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────

  var SCREENSHOT_PADDING = 20;
  var TEXT_MAX_LENGTH = 500;
  var Z_INDEX_HIGHLIGHT  = 2147483640;
  var Z_INDEX_CANVAS     = 2147483641;
  var Z_INDEX_CONNECTORS = 2147483643;
  var Z_INDEX_MARKERS    = 2147483644;
  var Z_INDEX_PANEL      = 2147483646;
  var Z_INDEX_TOOLTIP    = 2147483647;
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  var ALT_KEY_LABEL = IS_MAC ? "\u2325" : "Alt";

  // HTML escape to prevent XSS when inserting user-controlled content
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Check if element is part of fleet-annotate UI (by id or class)
  function isPickerElement(el) {
    if (!el) return false;
    if (el.id && el.id.startsWith("fleet-annotate-")) return true;
    var cls = el.className;
    if (!cls) return false;
    // Handle both string className and SVGAnimatedString
    var clsStr = typeof cls === "string" ? cls : cls.baseVal || "";
    return clsStr.split(/\s+/).some(function (c) { return c.startsWith("fa-"); });
  }

  // Update note card's displayed selector label
  function updateNoteCardLabel(index) {
    var sel = selectedElements[index];
    if (!sel) return;
    var card = notesContainer ? notesContainer.querySelector('[data-index="' + index + '"]') : null;
    if (!card) return;
    var label = sel.id ? "#" + sel.id : sel.tag + (sel.classes[0] ? "." + sel.classes[0] : "");
    var selectorEl = card.querySelector(".fa-note-selector");
    if (selectorEl) {
      selectorEl.textContent = label;
      selectorEl.title = sel.selector;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────

  var isActive = false;
  var multiSelectMode = false;

  // Element picker state
  var elementStack = [];
  var stackIndex = 0;
  var selectedElements = [];
  var elementScreenshots = new Map(); // index -> boolean
  var elementSnapshots = new Map();   // index -> { viewportRect, dpr } (captured at selection time)

  // Note card state
  var notesContainer = null;
  var connectorsEl = null;
  var elementComments = new Map(); // index -> comment string
  var openNotes = new Set();       // indices of currently open notes
  var notePositions = new Map();   // index -> {x, y} manual position overrides
  var dragState = null;            // { card, startX, startY, startLeft, startTop }

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

  // Debug mode state
  var debugMode = false;
  var cachedCSSVarNames = null;    // Cache for CSS variable discovery

  // DOM elements
  var highlightEl = null;
  var tooltipEl = null;
  var panelEl = null;
  var markersContainer = null;
  var styleEl = null;

  // ─────────────────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────────────────

  var STYLES = "\
    :root {\
      --fa-bg-body: #18181e;\
      --fa-bg-card: #1e1e24;\
      --fa-bg-elevated: #252530;\
      --fa-bg-selected: #3a3a4a;\
      --fa-bg-hover: #2b2b37;\
      --fa-fg: #e0e0e0;\
      --fa-fg-muted: #808080;\
      --fa-fg-dim: #666666;\
      --fa-accent: #8abeb7;\
      --fa-accent-hover: #9dcec7;\
      --fa-accent-muted: rgba(138, 190, 183, 0.15);\
      --fa-border: #5f87ff;\
      --fa-border-muted: #505050;\
      --fa-border-focus: #7a7a8a;\
      --fa-success: #b5bd68;\
      --fa-warning: #f0c674;\
      --fa-error: #cc6666;\
      --fa-focus-ring: rgba(95, 135, 255, 0.2);\
      --fa-shadow: rgba(0, 0, 0, 0.5);\
      --fa-font-mono: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;\
      --fa-font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\
      --fa-radius: 4px;\
    }\
    @media (prefers-color-scheme: light) {\
      :root {\
        --fa-bg-body: #f8f8f8;\
        --fa-bg-card: #ffffff;\
        --fa-bg-elevated: #f0f0f0;\
        --fa-bg-selected: #d0d0e0;\
        --fa-bg-hover: #e8e8e8;\
        --fa-fg: #1a1a1a;\
        --fa-fg-muted: #6c6c6c;\
        --fa-fg-dim: #8a8a8a;\
        --fa-accent: #5f8787;\
        --fa-accent-hover: #4a7272;\
        --fa-accent-muted: rgba(95, 135, 135, 0.15);\
        --fa-border: #5f87af;\
        --fa-border-muted: #b0b0b0;\
        --fa-border-focus: #8a8a9a;\
        --fa-success: #87af87;\
        --fa-warning: #d7af5f;\
        --fa-error: #af5f5f;\
        --fa-focus-ring: rgba(95, 135, 175, 0.2);\
        --fa-shadow: rgba(0, 0, 0, 0.15);\
      }\
    }\
    #fleet-annotate-highlight {\
      position: fixed;\
      pointer-events: none;\
      z-index: " + Z_INDEX_HIGHLIGHT + ";\
      background: var(--fa-accent-muted);\
      border: 2px solid var(--fa-accent);\
      border-radius: var(--fa-radius);\
      transition: all 0.05s ease-out;\
    }\
    #fleet-annotate-tooltip {\
      position: fixed;\
      pointer-events: none;\
      z-index: " + Z_INDEX_TOOLTIP + ";\
      background: var(--fa-bg-card);\
      color: var(--fa-fg);\
      padding: 6px 10px;\
      border-radius: var(--fa-radius);\
      border: 1px solid var(--fa-border-muted);\
      font: 12px/1.4 var(--fa-font-mono);\
      box-shadow: 0 2px 8px var(--fa-shadow);\
      max-width: 400px;\
    }\
    #fleet-annotate-tooltip .tag { color: var(--fa-error); }\
    #fleet-annotate-tooltip .id { color: var(--fa-warning); }\
    #fleet-annotate-tooltip .class { color: var(--fa-border); }\
    #fleet-annotate-tooltip .size { color: var(--fa-fg-dim); margin-left: 8px; }\
    #fleet-annotate-tooltip .hint { color: var(--fa-accent); font-size: 11px; margin-top: 4px; display: block; }\
    #fleet-annotate-markers {\
      position: fixed;\
      top: 0; left: 0;\
      width: 100%; height: 100%;\
      pointer-events: none;\
      z-index: " + Z_INDEX_MARKERS + ";\
    }\
    .fa-marker-outline {\
      position: fixed;\
      pointer-events: none;\
      border: 2px solid var(--fa-accent);\
      border-radius: var(--fa-radius);\
      background: var(--fa-accent-muted);\
    }\
    .fa-marker-badge {\
      position: fixed;\
      pointer-events: auto;\
      background: var(--fa-accent);\
      color: var(--fa-bg-body);\
      width: 28px;\
      height: 28px;\
      border-radius: 50%;\
      display: flex;\
      align-items: center;\
      justify-content: center;\
      font: bold 13px var(--fa-font-ui);\
      cursor: pointer;\
      box-shadow: 0 2px 8px var(--fa-shadow);\
      transition: transform 0.15s, box-shadow 0.15s;\
    }\
    .fa-marker-badge:hover {\
      transform: scale(1.1);\
      background: var(--fa-accent-hover);\
    }\
    .fa-marker-badge.open {\
      background: var(--fa-success);\
    }\
    .fa-connectors {\
      position: fixed;\
      top: 0; left: 0;\
      width: 100%; height: 100%;\
      pointer-events: none;\
      z-index: " + Z_INDEX_CONNECTORS + ";\
    }\
    .fa-connector {\
      fill: none;\
      stroke: var(--fa-accent);\
      stroke-opacity: 0.5;\
      stroke-width: 2;\
      stroke-dasharray: 6 4;\
    }\
    .fa-connector-dot {\
      fill: var(--fa-accent);\
    }\
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
    .fa-notes-container {\
      position: fixed;\
      top: 0; left: 0;\
      width: 100%; height: 100%;\
      pointer-events: none;\
      z-index: " + Z_INDEX_MARKERS + ";\
    }\
    .fa-note-card {\
      position: fixed;\
      width: 280px;\
      background: var(--fa-bg-card);\
      border: 1px solid var(--fa-border-muted);\
      border-radius: 8px;\
      box-shadow: 0 4px 24px var(--fa-shadow);\
      pointer-events: auto;\
      font-family: var(--fa-font-ui);\
      overflow: hidden;\
    }\
    .fa-note-card * { box-sizing: border-box; }\
    .fa-note-card:hover {\
      border-color: var(--fa-border-focus);\
    }\
    .fa-note-card.dragging {\
      opacity: 0.9;\
      cursor: grabbing;\
    }\
    .fa-note-header {\
      display: flex;\
      align-items: center;\
      gap: 8px;\
      padding: 8px 10px;\
      background: var(--fa-bg-elevated);\
      border-bottom: 1px solid var(--fa-border-muted);\
      cursor: grab;\
    }\
    .fa-note-badge {\
      background: var(--fa-accent);\
      color: var(--fa-bg-body);\
      width: 22px;\
      height: 22px;\
      border-radius: 50%;\
      display: flex;\
      align-items: center;\
      justify-content: center;\
      font: bold 11px var(--fa-font-ui);\
      flex-shrink: 0;\
    }\
    .fa-note-selector {\
      flex: 1;\
      font: 12px var(--fa-font-mono);\
      color: var(--fa-fg-muted);\
      overflow: hidden;\
      text-overflow: ellipsis;\
      white-space: nowrap;\
      cursor: pointer;\
    }\
    .fa-note-selector:hover {\
      color: var(--fa-accent);\
      text-decoration: underline;\
    }\
    .fa-note-screenshot,\
    .fa-note-close,\
    .fa-note-expand,\
    .fa-note-contract {\
      background: none;\
      border: none;\
      color: var(--fa-fg-dim);\
      font-size: 14px;\
      cursor: pointer;\
      padding: 2px 4px;\
      border-radius: var(--fa-radius);\
      transition: all 0.15s;\
    }\
    .fa-note-expand,\
    .fa-note-contract { font-size: 11px; }\
    .fa-note-expand:hover,\
    .fa-note-contract:hover { background: var(--fa-bg-elevated); color: var(--fa-fg-muted); }\
    .fa-note-screenshot { opacity: 0.4; }\
    .fa-note-screenshot:hover { background: var(--fa-bg-elevated); opacity: 0.7; }\
    .fa-note-screenshot.active { opacity: 1; background: var(--fa-accent-muted); }\
    .fa-note-close:hover { background: var(--fa-bg-elevated); color: var(--fa-error); }\
    .fa-note-body {\
      padding: 10px;\
    }\
    .fa-note-textarea {\
      width: 100%;\
      background: var(--fa-bg-body);\
      border: 1px solid var(--fa-border-muted);\
      border-radius: 6px;\
      color: var(--fa-fg);\
      font: 13px/1.5 var(--fa-font-ui);\
      padding: 10px 12px;\
      resize: none;\
      min-height: 72px;\
      max-height: 160px;\
      transition: border-color 0.15s, box-shadow 0.15s;\
    }\
    .fa-note-textarea:focus {\
      outline: none;\
      border-color: var(--fa-accent);\
      box-shadow: 0 0 0 3px var(--fa-focus-ring);\
    }\
    .fa-note-textarea::placeholder {\
      color: var(--fa-fg-dim);\
    }\
    #fleet-annotate-panel {\
      position: fixed;\
      bottom: 0; left: 0; right: 0;\
      background: var(--fa-bg-card);\
      color: var(--fa-fg);\
      font-family: var(--fa-font-ui);\
      padding: 10px 16px;\
      z-index: " + Z_INDEX_PANEL + ";\
      box-shadow: 0 -4px 24px var(--fa-shadow);\
      border-top: 1px solid var(--fa-border-muted);\
    }\
    #fleet-annotate-panel * { box-sizing: border-box; }\
    .fa-header {\
      display: flex;\
      align-items: center;\
      gap: 10px;\
      margin-bottom: 8px;\
      padding-bottom: 8px;\
      border-bottom: 1px solid var(--fa-bg-elevated);\
    }\
    .fa-logo {\
      font-size: 15px;\
      font-weight: 700;\
      color: var(--fa-accent);\
    }\
    .fa-hint { color: var(--fa-fg-dim); font-size: 11px; margin-left: auto; }\
    .fa-close {\
      background: none;\
      border: none;\
      color: var(--fa-fg-dim);\
      font-size: 18px;\
      cursor: pointer;\
      padding: 0 4px;\
      line-height: 1;\
    }\
    .fa-close:hover { color: var(--fa-error); }\
    .fa-toolbar {\
      display: flex;\
      align-items: center;\
      gap: 12px;\
      margin-bottom: 8px;\
    }\
    .fa-mode-toggle {\
      display: flex;\
      gap: 4px;\
    }\
    .fa-mode-btn {\
      background: var(--fa-bg-elevated);\
      border: 1px solid var(--fa-border-muted);\
      border-radius: var(--fa-radius);\
      padding: 5px 10px;\
      font-size: 11px;\
      color: var(--fa-fg-muted);\
      cursor: pointer;\
      transition: all 0.15s;\
    }\
    .fa-mode-btn:hover { background: var(--fa-bg-hover); }\
    .fa-mode-btn.active {\
      background: var(--fa-accent);\
      border-color: var(--fa-accent);\
      color: var(--fa-bg-body);\
    }\
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
    .fa-spacer { flex: 1; }\
    .fa-count {\
      font-size: 12px;\
      color: var(--fa-fg-dim);\
    }\
    .fa-notes-toggle {\
      display: flex;\
      align-items: center;\
      gap: 6px;\
      font-size: 12px;\
      color: var(--fa-fg-muted);\
      cursor: pointer;\
      user-select: none;\
    }\
    .fa-notes-toggle input {\
      width: 14px;\
      height: 14px;\
      accent-color: var(--fa-accent);\
      cursor: pointer;\
    }\
    .fa-notes-toggle:hover { color: var(--fa-fg); }\
    .fa-context-row {\
      margin-bottom: 8px;\
    }\
    .fa-context-row input {\
      width: 100%;\
      background: var(--fa-bg-body);\
      border: 1px solid var(--fa-border-muted);\
      border-radius: var(--fa-radius);\
      color: var(--fa-fg);\
      font-family: inherit;\
      font-size: 13px;\
      padding: 8px 12px;\
    }\
    .fa-context-row input:focus {\
      outline: none;\
      border-color: var(--fa-accent);\
      box-shadow: 0 0 0 3px var(--fa-focus-ring);\
    }\
    .fa-context-row input::placeholder { color: var(--fa-fg-dim); }\
    .fa-actions {\
      display: flex;\
      justify-content: flex-end;\
      padding-top: 8px;\
      border-top: 1px solid var(--fa-bg-elevated);\
    }\
    .fa-buttons { display: flex; gap: 8px; }\
    .fa-btn {\
      padding: 6px 14px;\
      border-radius: var(--fa-radius);\
      font-size: 12px;\
      font-weight: 500;\
      cursor: pointer;\
      border: none;\
      transition: all 0.15s;\
    }\
    .fa-btn-cancel {\
      background: var(--fa-bg-elevated);\
      color: var(--fa-fg-muted);\
      border: 1px solid var(--fa-border-muted);\
    }\
    .fa-btn-cancel:hover { background: var(--fa-bg-hover); color: var(--fa-fg); }\
    .fa-btn-submit {\
      background: var(--fa-accent);\
      color: var(--fa-bg-body);\
    }\
    .fa-btn-submit:hover {\
      background: var(--fa-accent-hover);\
    }\
  ";

  // ─────────────────────────────────────────────────────────────────────
  // Activation
  // ─────────────────────────────────────────────────────────────────────

  function activate() {
    if (isActive) {
      console.log("[fleet-annotate] Restarting session");
      resetState();
      return;
    }
    isActive = true;

    // Inject styles
    styleEl = document.createElement("style");
    styleEl.id = "fleet-annotate-styles";
    styleEl.textContent = STYLES;
    (document.head || document.documentElement).appendChild(styleEl);

    // Create UI
    createHighlight();
    createTooltip();
    createMarkers();
    createNotesContainer();
    createPanel();
    createCanvas();

    // Add listeners
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    initDragHandlers();

    document.body.style.cursor = "crosshair";
    console.log("[fleet-annotate] Activated");
  }

  function resetState() {
    elementStack = [];
    stackIndex = 0;
    selectedElements = [];
    elementScreenshots = new Map();
    elementSnapshots = new Map();
    elementComments = new Map();
    openNotes = new Set();
    notePositions = new Map();
    dragState = null;
    multiSelectMode = false;
    debugMode = false;
    resetCSSVarCache();

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

    // Reset UI elements
    if (markersContainer) markersContainer.innerHTML = "";
    if (notesContainer) notesContainer.innerHTML = "";
    if (connectorsEl) connectorsEl.innerHTML = "";
    hideHighlight();
    hideTooltip();

    // Reset mode toggle buttons
    var singleBtn = document.getElementById("fleet-annotate-mode-single");
    var multiBtn = document.getElementById("fleet-annotate-mode-multi");
    if (singleBtn && multiBtn) {
      singleBtn.classList.add("active");
      multiBtn.classList.remove("active");
    }

    // Clear context input
    var contextEl = document.getElementById("fleet-annotate-context");
    if (contextEl) contextEl.value = "";

    // Reset debug mode checkbox
    var debugCheckbox = document.getElementById("fleet-annotate-debug-mode");
    if (debugCheckbox) debugCheckbox.checked = false;

    // Update count
    var countEl = document.getElementById("fleet-annotate-count");
    if (countEl) countEl.textContent = "0 selected";

    console.log("[fleet-annotate] State reset for new session");
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;

    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("wheel", onWheel, { capture: true });
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", handleScroll, true);
    window.removeEventListener("resize", handleResize);
    cleanupDragHandlers();

    document.body.style.cursor = "";

    if (styleEl) styleEl.remove();
    if (highlightEl) highlightEl.remove();
    if (tooltipEl) tooltipEl.remove();
    if (panelEl) panelEl.remove();
    if (markersContainer) markersContainer.remove();
    if (notesContainer) notesContainer.remove();
    if (connectorsEl) connectorsEl.remove();

    styleEl = highlightEl = tooltipEl = panelEl = markersContainer = null;
    notesContainer = connectorsEl = null;
    if (canvasEl) canvasEl.remove();
    canvasEl = null;
    canvasCtx = null;
    if (textInputEl) { textInputEl.remove(); textInputEl = null; }
    drawOps = [];
    currentDrawOp = null;
    undoStack = [];
    activeTool = "pick";
    drawMouseDown = false;
    elementStack = [];
    stackIndex = 0;
    selectedElements = [];
    elementScreenshots = new Map();
    elementSnapshots = new Map();
    elementComments = new Map();
    openNotes = new Set();
    notePositions = new Map();
    dragState = null;
    multiSelectMode = false;
    debugMode = false;
    resetCSSVarCache();

    console.log("[fleet-annotate] Deactivated");
  }

  // ─────────────────────────────────────────────────────────────────────
  // UI Creation
  // ─────────────────────────────────────────────────────────────────────

  function createHighlight() {
    highlightEl = document.createElement("div");
    highlightEl.id = "fleet-annotate-highlight";
    highlightEl.style.display = "none";
    document.body.appendChild(highlightEl);
  }

  function createTooltip() {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "fleet-annotate-tooltip";
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);
  }

  function createMarkers() {
    markersContainer = document.createElement("div");
    markersContainer.id = "fleet-annotate-markers";
    document.body.appendChild(markersContainer);
  }

  function createNotesContainer() {
    notesContainer = document.createElement("div");
    notesContainer.className = "fa-notes-container";
    document.body.appendChild(notesContainer);

    connectorsEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    connectorsEl.setAttribute("class", "fa-connectors");
    document.body.appendChild(connectorsEl);
  }

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

  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "fleet-annotate-panel";
    panelEl.innerHTML = '\
      <div class="fa-header">\
        <span class="fa-logo">Fleet Annotate</span>\
        <span class="fa-hint">Click elements \u2022 ' + ALT_KEY_LABEL + '+scroll cycles parents \u2022 ESC to close</span>\
        <button class="fa-close" id="fleet-annotate-close" title="Close (ESC)">\u00d7</button>\
      </div>\
      <div class="fa-toolbar">\
        <div class="fa-mode-toggle">\
          <button class="fa-mode-btn active" id="fleet-annotate-mode-single" title="Click replaces selection">Single</button>\
          <button class="fa-mode-btn" id="fleet-annotate-mode-multi" title="Click adds to selection">Multi</button>\
        </div>\
        <div class="fa-draw-tools">\
          <button class="fa-tool-btn" data-tool="pen" title="Pen (P)">\u270E</button>\
          <button class="fa-tool-btn" data-tool="line" title="Line / Arrow (L, hold Shift for arrow)">\u2571</button>\
          <button class="fa-tool-btn" data-tool="shape" title="Shape (S)">\u25A1</button>\
          <button class="fa-tool-btn" data-tool="text" title="Text (T)">T</button>\
        </div>\
        <div class="fa-color-swatches" id="fleet-annotate-colors"></div>\
        <div class="fa-width-toggle" id="fleet-annotate-widths"></div>\
        <div class="fa-spacer"></div>\
        <span class="fa-count" id="fleet-annotate-count">0 selected</span>\
        <label class="fa-notes-toggle" title="Show/hide all note cards">\
          <input type="checkbox" id="fleet-annotate-notes-visible" checked />\
          <span>Notes</span>\
        </label>\
        <label class="fa-notes-toggle" title="Capture computed styles, layout, and CSS variables">\
          <input type="checkbox" id="fleet-annotate-debug-mode" />\
          <span>Debug</span>\
        </label>\
      </div>\
      <div class="fa-context-row">\
        <input type="text" id="fleet-annotate-context" placeholder="General context (optional)..." />\
      </div>\
      <div class="fa-actions">\
        <div class="fa-buttons">\
          <button class="fa-btn fa-btn-cancel" id="fleet-annotate-cancel">Cancel</button>\
          <button class="fa-btn fa-btn-submit" id="fleet-annotate-submit">Submit</button>\
        </div>\
      </div>\
    ';
    document.body.appendChild(panelEl);

    document.getElementById("fleet-annotate-close").addEventListener("click", handleCancel);
    document.getElementById("fleet-annotate-cancel").addEventListener("click", handleCancel);
    document.getElementById("fleet-annotate-submit").addEventListener("click", handleSubmit);

    // Mode toggle
    document.getElementById("fleet-annotate-mode-single").addEventListener("click", function () { setMultiMode(false); });
    document.getElementById("fleet-annotate-mode-multi").addEventListener("click", function () { setMultiMode(true); });

    // Notes visibility toggle
    document.getElementById("fleet-annotate-notes-visible").addEventListener("change", function (e) {
      if (e.target.checked) {
        expandAllNotes();
      } else {
        collapseAllNotes();
      }
    });

    // Debug mode toggle
    document.getElementById("fleet-annotate-debug-mode").addEventListener("change", function (e) {
      debugMode = e.target.checked;
    });

    // Stop events from reaching the page
    panelEl.addEventListener("mousemove", function (e) { e.stopPropagation(); }, true);
    panelEl.addEventListener("click", function (e) {
      var target = e.target;
      if (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        return;
      }
      e.stopPropagation();
    }, true);

    initDrawToolbar();
  }

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
        if (tool === "shape" && activeTool === "shape") {
          toggleShape();
        } else if (activeTool === tool) {
          setActiveTool("pick");
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

  function setMultiMode(isMulti) {
    setActiveTool("pick");
    multiSelectMode = isMulti;
    var singleBtn = document.getElementById("fleet-annotate-mode-single");
    var multiBtn = document.getElementById("fleet-annotate-mode-multi");
    if (singleBtn && multiBtn) {
      singleBtn.classList.toggle("active", !isMulti);
      multiBtn.classList.toggle("active", isMulti);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Note Card Functions
  // ─────────────────────────────────────────────────────────────────────

  function calculateNotePosition(element, cardWidth, cardHeight) {
    cardWidth = cardWidth || 280;
    cardHeight = cardHeight || 150;
    var rect = element.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var panelHeight = (document.getElementById("fleet-annotate-panel") || {}).offsetHeight || 96;
    var margin = 16;

    // Try right side first
    if (rect.right + margin + cardWidth < vw) {
      return { x: rect.right + margin, y: Math.max(margin, rect.top) };
    }
    // Try left side
    if (rect.left - margin - cardWidth > 0) {
      return { x: rect.left - margin - cardWidth, y: Math.max(margin, rect.top) };
    }
    // Try below
    if (rect.bottom + margin + cardHeight < vh - panelHeight) {
      return { x: Math.max(margin, rect.left), y: rect.bottom + margin };
    }
    // Try above
    if (rect.top - margin - cardHeight > 0) {
      return { x: Math.max(margin, rect.left), y: rect.top - margin - cardHeight };
    }
    // Fallback: offset from element
    return { x: Math.min(rect.right + margin, vw - cardWidth - margin), y: Math.max(margin, rect.top) };
  }

  function hasOverlap(rect1, rect2, margin) {
    margin = margin || 8;
    return !(
      rect1.right + margin < rect2.left ||
      rect1.left > rect2.right + margin ||
      rect1.bottom + margin < rect2.top ||
      rect1.top > rect2.bottom + margin
    );
  }

  function adjustForCollisions(position, cardSize, existingCards) {
    var myRect = {
      left: position.x,
      top: position.y,
      right: position.x + cardSize.width,
      bottom: position.y + cardSize.height
    };

    var adjusted = { x: position.x, y: position.y };
    var attempts = 0;

    while (attempts < 10) {
      var collision = false;

      for (var ci = 0; ci < existingCards.length; ci++) {
        var cardRect = existingCards[ci].getBoundingClientRect();
        if (hasOverlap(myRect, cardRect)) {
          adjusted.y = cardRect.bottom + 12;
          myRect.top = adjusted.y;
          myRect.bottom = adjusted.y + cardSize.height;
          collision = true;
          break;
        }
      }

      if (!collision) break;
      attempts++;
    }

    // Clamp to viewport
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var panelHeight = (document.getElementById("fleet-annotate-panel") || {}).offsetHeight || 96;
    adjusted.x = Math.max(16, Math.min(adjusted.x, vw - cardSize.width - 16));
    adjusted.y = Math.max(16, Math.min(adjusted.y, vh - cardSize.height - panelHeight - 16));

    return adjusted;
  }

  function createNoteCard(index) {
    var sel = selectedElements[index];
    if (!sel || !sel.element || !document.contains(sel.element)) return null;

    // Guard against duplicate cards
    if (openNotes.has(index)) {
      return notesContainer.querySelector('[data-index="' + index + '"]');
    }

    // Use stored position if user previously dragged, otherwise calculate
    var adjustedPos;
    if (notePositions.has(index)) {
      adjustedPos = notePositions.get(index);
    } else {
      var position = calculateNotePosition(sel.element);
      adjustedPos = adjustForCollisions(
        position,
        { width: 280, height: 150 },
        notesContainer.querySelectorAll(".fa-note-card")
      );
    }

    var label = sel.id ? "#" + sel.id : sel.tag + (sel.classes[0] ? "." + sel.classes[0] : "");
    var hasScreenshot = elementScreenshots.get(index) !== false;
    var comment = elementComments.get(index) || "";

    var card = document.createElement("div");
    card.className = "fa-note-card";
    card.dataset.index = index;
    card.style.left = adjustedPos.x + "px";
    card.style.top = adjustedPos.y + "px";

    card.innerHTML = '\
      <div class="fa-note-header">\
        <span class="fa-note-badge">' + (index + 1) + '</span>\
        <span class="fa-note-selector" title="' + escapeHtml(sel.selector) + '">' + escapeHtml(label) + '</span>\
        <button class="fa-note-expand" title="Expand to parent">\u25b2</button>\
        <button class="fa-note-contract" title="Contract to child">\u25bc</button>\
        <button class="fa-note-screenshot ' + (hasScreenshot ? "active" : "") + '" title="Toggle screenshot">\ud83d\udcf7</button>\
        <button class="fa-note-close" title="Remove element">\u00d7</button>\
      </div>\
      <div class="fa-note-body">\
        <textarea class="fa-note-textarea" placeholder="Describe changes for this element...">' + escapeHtml(comment) + '</textarea>\
      </div>\
    ';

    // Helper to get current index from DOM (survives reindexing)
    var getIndex = function () { return parseInt(card.dataset.index, 10); };

    // Event listeners
    var textarea = card.querySelector(".fa-note-textarea");
    textarea.addEventListener("input", function () {
      elementComments.set(getIndex(), textarea.value);
      autoResizeTextarea(textarea);
    });

    var screenshotBtn = card.querySelector(".fa-note-screenshot");
    screenshotBtn.addEventListener("click", function () {
      var idx = getIndex();
      var current = elementScreenshots.get(idx) !== false;
      elementScreenshots.set(idx, !current);
      screenshotBtn.classList.toggle("active", !current);
    });

    var closeBtn = card.querySelector(".fa-note-close");
    closeBtn.addEventListener("click", function () { removeElement(getIndex()); });

    var expandBtn = card.querySelector(".fa-note-expand");
    expandBtn.addEventListener("click", function () { expandElement(getIndex()); });

    var contractBtn = card.querySelector(".fa-note-contract");
    contractBtn.addEventListener("click", function () { contractElement(getIndex()); });

    var selectorEl = card.querySelector(".fa-note-selector");
    selectorEl.addEventListener("click", function () {
      var idx = getIndex();
      var currentSel = selectedElements[idx];
      if (currentSel && currentSel.element) scrollToElement(currentSel.element);
    });

    // Drag to reposition
    setupDrag(card);

    notesContainer.appendChild(card);
    openNotes.add(index);

    // Focus textarea
    textarea.focus();

    return card;
  }

  function toggleNote(index) {
    if (openNotes.has(index)) {
      // Close note
      var card = notesContainer.querySelector('[data-index="' + index + '"]');
      if (card) card.remove();
      openNotes.delete(index);
    } else {
      // Open note
      createNoteCard(index);
    }
    updateBadges();
    updateConnectors();
  }

  function autoResizeTextarea(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(160, Math.max(72, textarea.scrollHeight)) + "px";
  }

  // ─────────────────────────────────────────────────────────────────────
  // Drag Handling
  // ─────────────────────────────────────────────────────────────────────

  function initDragHandlers() {
    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  }

  function cleanupDragHandlers() {
    document.removeEventListener("mousemove", handleDragMove);
    document.removeEventListener("mouseup", handleDragEnd);
  }

  function handleDragMove(e) {
    if (!dragState) return;
    var card = dragState.card;
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    var newX = dragState.startLeft + dx;
    var newY = dragState.startTop + dy;
    card.style.left = newX + "px";
    card.style.top = newY + "px";
    var index = parseInt(card.dataset.index, 10);
    notePositions.set(index, { x: newX, y: newY });
    updateConnectors();
  }

  function handleDragEnd() {
    if (dragState) {
      dragState.card.classList.remove("dragging");
      dragState = null;
    }
  }

  function setupDrag(card) {
    var header = card.querySelector(".fa-note-header");

    header.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "SPAN") return;
      dragState = {
        card: card,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: card.offsetLeft,
        startTop: card.offsetTop
      };
      card.classList.add("dragging");
      e.preventDefault();
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Element Management
  // ─────────────────────────────────────────────────────────────────────

  function removeElement(index) {
    selectedElements.splice(index, 1);

    // Close and remove the note card if open
    if (openNotes.has(index)) {
      var card = notesContainer.querySelector('[data-index="' + index + '"]');
      if (card) card.remove();
      openNotes.delete(index);
    }

    // Reindex all state Maps and Sets
    var reindexMap = function (map) {
      var newMap = new Map();
      map.forEach(function (v, k) {
        if (k < index) newMap.set(k, v);
        else if (k > index) newMap.set(k - 1, v);
      });
      return newMap;
    };

    var reindexSet = function (set) {
      var newSet = new Set();
      set.forEach(function (k) {
        if (k < index) newSet.add(k);
        else if (k > index) newSet.add(k - 1);
      });
      return newSet;
    };

    elementScreenshots = reindexMap(elementScreenshots);
    elementComments = reindexMap(elementComments);
    notePositions = reindexMap(notePositions);
    openNotes = reindexSet(openNotes);

    // Update data-index attributes on remaining note cards
    notesContainer.querySelectorAll(".fa-note-card").forEach(function (card) {
      var cardIndex = parseInt(card.dataset.index, 10);
      if (cardIndex > index) {
        var newIndex = cardIndex - 1;
        card.dataset.index = newIndex;
        var badge = card.querySelector(".fa-note-badge");
        if (badge) badge.textContent = newIndex + 1;
      }
    });

    updateBadges();
    updateConnectors();
  }

  function expandElement(index) {
    var sel = selectedElements[index];
    if (!sel || !sel.element || !document.contains(sel.element)) return;

    var parent = sel.element.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      if (isPickerElement(parent)) {
        console.log("[fleet-annotate] Cannot expand to picker UI element");
        return;
      }

      console.log("[fleet-annotate] Expanding to parent:", parent.tagName);
      selectedElements[index] = createSelectionData(parent);
      updateNoteCardLabel(index);
      updateBadges();
      updateConnectors();
    } else {
      console.log("[fleet-annotate] Already at root - no valid parent");
    }
  }

  function contractElement(index) {
    var sel = selectedElements[index];
    if (!sel || !sel.element || !document.contains(sel.element)) return;

    var children = Array.from(sel.element.children).filter(function (c) {
      return c.nodeType === 1 && !isPickerElement(c);
    });

    if (children.length > 0) {
      console.log("[fleet-annotate] Contracting to child:", children[0].tagName);
      selectedElements[index] = createSelectionData(children[0]);
      updateNoteCardLabel(index);
      updateBadges();
      updateConnectors();
    } else {
      console.log("[fleet-annotate] No children to contract to");
    }
  }

  function scrollToElement(element) {
    if (!element || !document.contains(element)) return;

    element.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center"
    });

    // Flash highlight effect after scroll
    setTimeout(function () {
      if (!element || !document.contains(element)) return;

      var rect = element.getBoundingClientRect();
      highlightEl.style.display = "";
      highlightEl.style.left = rect.left + "px";
      highlightEl.style.top = rect.top + "px";
      highlightEl.style.width = rect.width + "px";
      highlightEl.style.height = rect.height + "px";
      highlightEl.style.transition = "opacity 0.3s";
      highlightEl.style.opacity = "1";

      setTimeout(function () {
        highlightEl.style.opacity = "0";
        setTimeout(function () {
          highlightEl.style.display = "none";
          highlightEl.style.transition = "";
          highlightEl.style.opacity = "";
        }, 300);
      }, 500);
    }, 400);
  }

  function expandAllNotes() {
    selectedElements.forEach(function (_, i) {
      if (!openNotes.has(i)) {
        createNoteCard(i);
      }
    });
    updateBadges();
    updateConnectors();
  }

  function collapseAllNotes() {
    openNotes.forEach(function (i) {
      var card = notesContainer.querySelector('[data-index="' + i + '"]');
      if (card) card.remove();
    });
    openNotes.clear();
    updateBadges();
    updateConnectors();
  }

  // ─────────────────────────────────────────────────────────────────────
  // UI Updates
  // ─────────────────────────────────────────────────────────────────────

  function updateBadges() {
    if (!markersContainer) return;
    markersContainer.innerHTML = "";

    selectedElements.forEach(function (sel, i) {
      if (!sel.element || !document.contains(sel.element)) return;

      var rect = sel.element.getBoundingClientRect();

      // Create outline box around selected element
      var outline = document.createElement("div");
      outline.className = "fa-marker-outline";
      outline.style.left = rect.left + "px";
      outline.style.top = rect.top + "px";
      outline.style.width = rect.width + "px";
      outline.style.height = rect.height + "px";
      markersContainer.appendChild(outline);

      // Create numbered badge
      var badge = document.createElement("div");
      badge.className = "fa-marker-badge" + (openNotes.has(i) ? " open" : "");
      badge.dataset.index = i;
      badge.textContent = i + 1;
      badge.style.left = (rect.right - 14) + "px";
      badge.style.top = (rect.top - 14) + "px";

      badge.addEventListener("click", (function (idx) {
        return function (e) {
          e.stopPropagation();
          toggleNote(idx);
        };
      })(i));

      markersContainer.appendChild(badge);
    });

    // Update count
    var countEl = document.getElementById("fleet-annotate-count");
    if (countEl) countEl.textContent = selectedElements.length + " selected";
  }

  function updateConnectors() {
    if (!connectorsEl) return;
    connectorsEl.innerHTML = "";

    selectedElements.forEach(function (sel, i) {
      if (!openNotes.has(i)) return;

      var card = notesContainer.querySelector('[data-index="' + i + '"]');
      if (!card || !sel.element || !document.contains(sel.element)) return;

      var elemRect = sel.element.getBoundingClientRect();
      var cardRect = card.getBoundingClientRect();

      var elemCenter = {
        x: elemRect.left + elemRect.width / 2,
        y: elemRect.top + elemRect.height / 2
      };

      var cardAnchor;
      if (cardRect.left > elemRect.right) {
        cardAnchor = { x: cardRect.left, y: cardRect.top + 20 };
      } else if (cardRect.right < elemRect.left) {
        cardAnchor = { x: cardRect.right, y: cardRect.top + 20 };
      } else if (cardRect.top > elemRect.bottom) {
        cardAnchor = { x: cardRect.left + 20, y: cardRect.top };
      } else if (cardRect.bottom < elemRect.top) {
        cardAnchor = { x: cardRect.left + 20, y: cardRect.bottom };
      } else {
        return; // Card overlaps element
      }

      var midX = (elemCenter.x + cardAnchor.x) / 2;
      var midY = (elemCenter.y + cardAnchor.y) / 2;

      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "fa-connector");
      path.setAttribute("d", "M " + elemCenter.x + "," + elemCenter.y + " Q " + midX + "," + midY + " " + cardAnchor.x + "," + cardAnchor.y);
      connectorsEl.appendChild(path);

      var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("class", "fa-connector-dot");
      dot.setAttribute("cx", elemCenter.x);
      dot.setAttribute("cy", elemCenter.y);
      dot.setAttribute("r", 4);
      connectorsEl.appendChild(dot);
    });
  }

  function updateHighlight() {
    var el = elementStack[stackIndex];
    if (!el) return hideHighlight();

    var rect = el.getBoundingClientRect();
    highlightEl.style.display = "";
    highlightEl.style.left = rect.left + "px";
    highlightEl.style.top = rect.top + "px";
    highlightEl.style.width = rect.width + "px";
    highlightEl.style.height = rect.height + "px";
  }

  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = "none";
  }

  function updateTooltip(mx, my) {
    var el = elementStack[stackIndex];
    if (!el) return hideTooltip();

    var rect = el.getBoundingClientRect();
    var tag = el.tagName.toLowerCase();
    var id = el.id;
    var classes = Array.from(el.classList).slice(0, 3);

    var html = '<span class="tag">' + escapeHtml(tag) + '</span>';
    if (id) html += '<span class="id">#' + escapeHtml(id) + '</span>';
    if (classes.length) html += '<span class="class">.' + escapeHtml(classes.join(".")) + '</span>';
    html += '<span class="size">' + Math.round(rect.width) + '\u00d7' + Math.round(rect.height) + '</span>';
    if (elementStack.length > 1) {
      html += '<span class="hint">' + ALT_KEY_LABEL + '+\u25b2\u25bc ' + (stackIndex + 1) + '/' + elementStack.length + '</span>';
    }

    tooltipEl.innerHTML = html;
    tooltipEl.style.display = "";

    var tx = mx + 15, ty = my + 15;
    var tr = tooltipEl.getBoundingClientRect();
    if (tx + tr.width > window.innerWidth - 10) tx = mx - tr.width - 10;
    if (ty + tr.height > window.innerHeight - 100) ty = my - tr.height - 10;

    tooltipEl.style.left = tx + "px";
    tooltipEl.style.top = ty + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  // ─────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────

  function onMouseMove(e) {
    if (!isActive || e.target.closest("#fleet-annotate-panel") || e.target.closest(".fa-note-card")) {
      hideHighlight();
      hideTooltip();
      return;
    }

    highlightEl.style.display = "none";
    tooltipEl.style.display = "none";
    var el = document.elementFromPoint(e.clientX, e.clientY);
    highlightEl.style.display = "";

    if (!el || el === document.body || el === document.documentElement || isPickerElement(el)) {
      hideHighlight();
      hideTooltip();
      return;
    }

    // Build parent chain
    elementStack = [];
    var current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (!isPickerElement(current)) {
        elementStack.push(current);
      }
      current = current.parentElement;
    }
    stackIndex = 0;

    updateHighlight();
    updateTooltip(e.clientX, e.clientY);
  }

  function onWheel(e) {
    if (!isActive || !elementStack.length || e.target.closest("#fleet-annotate-panel") || e.target.closest(".fa-note-card")) return;

    if (!e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    stackIndex = e.deltaY > 0
      ? Math.min(stackIndex + 1, elementStack.length - 1)
      : Math.max(stackIndex - 1, 0);

    updateHighlight();
    updateTooltip(e.clientX, e.clientY);
  }

  function onClick(e) {
    if (!isActive || e.target.closest("#fleet-annotate-panel") || e.target.closest(".fa-note-card")) return;

    e.preventDefault();
    e.stopPropagation();

    var el = elementStack[stackIndex];
    if (!el) return;

    var idx = selectedElements.findIndex(function (s) { return s.element === el; });

    if (idx >= 0) {
      // Already selected - deselect it
      removeElement(idx);
      return;
    }

    // Not selected - add it
    var addToExisting = multiSelectMode || e.shiftKey;
    if (!addToExisting) {
      // Clear existing selections
      collapseAllNotes();
      selectedElements = [];
      elementScreenshots = new Map();
      elementSnapshots = new Map();
      elementComments = new Map();
      notePositions = new Map();
    }
    selectElement(el);

    // Auto-open note for the newly selected element
    var newIndex = selectedElements.length - 1;
    createNoteCard(newIndex);

    updateBadges();
    updateConnectors();
  }

  function onKeyDown(e) {
    if (!isActive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  }

  function handleScroll() {
    updateBadges();
    updateConnectors();
  }

  function handleResize() {
    sizeCanvas();
    updateBadges();
    var panelHeight = (document.getElementById("fleet-annotate-panel") || {}).offsetHeight || 96;

    openNotes.forEach(function (index) {
      var card = notesContainer.querySelector('[data-index="' + index + '"]');
      if (!card) return;

      var rect = card.getBoundingClientRect();
      var vw = window.innerWidth;
      var vh = window.innerHeight;

      var newX = card.offsetLeft;
      var newY = card.offsetTop;
      var moved = false;

      if (rect.right > vw - 16) {
        newX = vw - rect.width - 16;
        moved = true;
      }
      if (rect.bottom > vh - panelHeight - 16) {
        newY = vh - rect.height - panelHeight - 16;
        moved = true;
      }

      if (moved) {
        card.style.left = newX + "px";
        card.style.top = newY + "px";
        notePositions.set(index, { x: newX, y: newY });
      }
    });
    updateConnectors();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Selection
  // ─────────────────────────────────────────────────────────────────────

  function selectElement(el) {
    selectedElements.push(createSelectionData(el));
    var idx = selectedElements.length - 1;
    // Capture a viewport snapshot immediately so transient elements (hover menus etc.) are preserved
    var vr = el.getBoundingClientRect();
    var snapshotData = {
      index: idx,
      viewportRect: { x: vr.x, y: vr.y, width: vr.width, height: vr.height },
      dpr: window.devicePixelRatio || 1
    };
    elementSnapshots.set(idx, snapshotData);
    // Ask main process to capture + crop now while the element is visible
    if (window.fleetAnnotate && window.fleetAnnotate.snapshotElement) {
      window.fleetAnnotate.snapshotElement(snapshotData).catch(function () { /* ignore */ });
    }
  }

  function generateSelector(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return "#" + el.id;

    if (el.classList.length) {
      var classes = Array.from(el.classList).filter(function (c) { return /^[a-zA-Z][\w-]*$/.test(c); });
      if (classes.length) {
        var sel = el.tagName.toLowerCase() + "." + classes.join(".");
        try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (ex) { /* ignore */ }
      }
    }

    var path = [];
    var cur = el;
    while (cur && cur !== document.body) {
      var part = cur.tagName.toLowerCase();
      if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
        path.unshift("#" + cur.id);
        break;
      }
      var parent = cur.parentElement;
      if (parent) {
        var sibs = Array.from(parent.children).filter(function (c) { return c.tagName === cur.tagName; });
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
      }
      path.unshift(part);
      cur = parent;
    }
    return path.join(" > ");
  }

  /**
   * Get all HTML attributes for an element (except class/id which are captured separately)
   */
  function getAttrs(el) {
    var attrs = {};
    for (var ai = 0; ai < el.attributes.length; ai++) {
      var attr = el.attributes[ai];
      if (attr.name === "class" || attr.name === "id") continue;
      if (attr.name === "style") continue;
      attrs[attr.name] = attr.value.length > 200 ? attr.value.slice(0, 200) + "\u2026" : attr.value;
    }
    return attrs;
  }

  function createSelectionData(el) {
    var data = {
      element: el,
      selector: generateSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      text: (el.textContent || "").slice(0, TEXT_MAX_LENGTH).trim().replace(/\s+/g, " "),
      rect: getRectData(el),
      attributes: getAttrs(el),
      boxModel: getBoxModel(el),
      accessibility: getAccessibilityInfo(el),
      keyStyles: getKeyStyles(el)
    };

    if (debugMode) {
      data.computedStyles = getComputedStyles(el);
      data.parentContext = getParentContext(el);
      data.cssVariables = getCSSVariables(el);
    }

    return data;
  }

  function getRectData(el) {
    var rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // DevTools Context Helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Get box model breakdown (content, padding, border, margin)
   */
  function getBoxModel(el) {
    var style = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();

    var paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    var paddingV = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    var borderH = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    var borderV = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);

    return {
      content: {
        width: Math.max(0, Math.round(rect.width - paddingH - borderH)),
        height: Math.max(0, Math.round(rect.height - paddingV - borderV))
      },
      padding: {
        top: Math.round(parseFloat(style.paddingTop)),
        right: Math.round(parseFloat(style.paddingRight)),
        bottom: Math.round(parseFloat(style.paddingBottom)),
        left: Math.round(parseFloat(style.paddingLeft))
      },
      border: {
        top: Math.round(parseFloat(style.borderTopWidth)),
        right: Math.round(parseFloat(style.borderRightWidth)),
        bottom: Math.round(parseFloat(style.borderBottomWidth)),
        left: Math.round(parseFloat(style.borderLeftWidth))
      },
      margin: {
        top: Math.round(parseFloat(style.marginTop)),
        right: Math.round(parseFloat(style.marginRight)),
        bottom: Math.round(parseFloat(style.marginBottom)),
        left: Math.round(parseFloat(style.marginLeft))
      }
    };
  }

  // ARIA role mappings
  var INPUT_TYPE_ROLES = {
    button: "button",
    submit: "button",
    reset: "button",
    image: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    number: "spinbutton",
    search: "searchbox",
    email: "textbox",
    tel: "textbox",
    url: "textbox",
    text: "textbox",
    password: "textbox"
  };

  var TAG_ROLES = {
    article: "article",
    aside: "complementary",
    button: "button",
    datalist: "listbox",
    details: "group",
    dialog: "dialog",
    fieldset: "group",
    figure: "figure",
    footer: "contentinfo",
    form: "form",
    h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading",
    header: "banner",
    hr: "separator",
    li: "listitem",
    main: "main",
    math: "math",
    menu: "list",
    nav: "navigation",
    ol: "list",
    optgroup: "group",
    option: "option",
    output: "status",
    progress: "progressbar",
    section: "region",
    select: "combobox",
    summary: "button",
    table: "table",
    tbody: "rowgroup",
    td: "cell",
    textarea: "textbox",
    tfoot: "rowgroup",
    th: "columnheader",
    thead: "rowgroup",
    tr: "row",
    ul: "list"
  };

  /**
   * Get implicit ARIA role for an element based on tag and attributes
   */
  function getImplicitRole(el) {
    var tag = el.tagName.toLowerCase();
    var type = el.getAttribute("type");
    if (type) type = type.toLowerCase();

    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "area") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") return type ? (INPUT_TYPE_ROLES[type] || "textbox") : "textbox";
    if (tag === "img") {
      var alt = el.getAttribute("alt");
      if (alt === null) return "img";
      if (alt === "") return "presentation";
      return "img";
    }

    return TAG_ROLES[tag] || null;
  }

  /**
   * Check if element can receive keyboard focus
   */
  function isFocusable(el) {
    if (el.hasAttribute("tabindex")) {
      return el.tabIndex >= 0;
    }
    if (el.disabled) return false;

    var tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") {
      return el.hasAttribute("href");
    }

    return ["button", "input", "select", "textarea"].indexOf(tag) >= 0;
  }

  /**
   * Get computed accessible name for an element
   */
  function getAccessibleName(el) {
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var name = labelledBy.split(/\s+/)
        .map(function (id) { var e = document.getElementById(id); return e ? (e.textContent || "").trim() : ""; })
        .filter(Boolean).join(" ");
      if (name) return name;
    }

    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel;

    var tag = el.tagName.toLowerCase();
    var labelable = ["input", "select", "textarea", "button", "meter", "progress", "output"];
    if (el.id && labelable.indexOf(tag) >= 0) {
      var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return (label.textContent || "").trim() || null;
    }

    var title = el.getAttribute("title");
    if (title) return title;

    if (["button", "a", "label", "legend", "caption"].indexOf(tag) >= 0) {
      var text = (el.textContent || "").trim();
      return text ? text.slice(0, 100) : null;
    }

    if (tag === "img") {
      return el.getAttribute("alt") || null;
    }

    return null;
  }

  /**
   * Get aria-describedby content
   */
  function getAccessibleDescription(el) {
    var describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      return describedBy.split(/\s+/)
        .map(function (id) { var e = document.getElementById(id); return e ? (e.textContent || "").trim() : ""; })
        .filter(Boolean).join(" ") || null;
    }
    return null;
  }

  /**
   * Get accessibility information for an element
   */
  function getAccessibilityInfo(el) {
    var role = el.getAttribute("role") || getImplicitRole(el);
    var ariaExpanded = el.getAttribute("aria-expanded");
    var ariaPressed = el.getAttribute("aria-pressed");
    var ariaChecked = el.getAttribute("aria-checked");
    var ariaSelected = el.getAttribute("aria-selected");

    var parseAriaBoolean = function (val) { return val === "true" ? true : val === "false" ? false : undefined; };

    return {
      role: role,
      name: getAccessibleName(el),
      description: getAccessibleDescription(el),
      focusable: isFocusable(el),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      expanded: parseAriaBoolean(ariaExpanded),
      pressed: parseAriaBoolean(ariaPressed),
      checked: typeof el.checked === "boolean" ? el.checked : parseAriaBoolean(ariaChecked),
      selected: typeof el.selected === "boolean" ? el.selected : parseAriaBoolean(ariaSelected)
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Key Styles (always captured)
  // ─────────────────────────────────────────────────────────────────────

  var KEY_STYLE_DEFAULTS = {
    position: ["static"],
    overflow: ["visible"],
    zIndex: ["auto"],
    opacity: ["1"],
    color: ["rgb(0, 0, 0)"],
    backgroundColor: ["rgba(0, 0, 0, 0)", "transparent"],
    fontSize: ["16px"],
    fontWeight: ["400", "normal"]
  };

  /**
   * Get a small set of layout-critical CSS properties (always captured)
   */
  function getKeyStyles(el) {
    var computed = window.getComputedStyle(el);
    var styles = {};
    var display = computed.display;
    if (display) styles.display = display;
    var keys = Object.keys(KEY_STYLE_DEFAULTS);
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var value = computed[key];
      if (value && KEY_STYLE_DEFAULTS[key].indexOf(value) === -1) {
        styles[key] = value;
      }
    }
    return styles;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Debug Mode Helpers
  // ─────────────────────────────────────────────────────────────────────

  var COMPUTED_STYLE_KEYS = [
    "display", "position", "top", "right", "bottom", "left",
    "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
    "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignSelf", "flex", "gap",
    "gridTemplateColumns", "gridTemplateRows", "gridColumn", "gridRow",
    "overflow", "overflowX", "overflowY", "zIndex", "opacity", "visibility",
    "color", "fontSize", "fontWeight", "fontFamily", "lineHeight", "textAlign",
    "backgroundColor", "backgroundImage", "borderRadius", "boxShadow",
    "transform", "transformOrigin",
    "cursor", "pointerEvents", "userSelect"
  ];

  var DEFAULT_STYLE_VALUES_LIST = [
    "none", "auto", "normal", "visible", "static", "baseline",
    "0px", "0", "1", "start", "stretch", "row", "nowrap",
    "rgba(0, 0, 0, 0)", "rgb(0, 0, 0)", "transparent"
  ];

  /**
   * Get computed styles (debug mode only)
   */
  function getComputedStyles(el) {
    var computed = window.getComputedStyle(el);
    var styles = {};

    for (var si = 0; si < COMPUTED_STYLE_KEYS.length; si++) {
      var key = COMPUTED_STYLE_KEYS[si];
      var value = computed[key];
      if (value && DEFAULT_STYLE_VALUES_LIST.indexOf(value) === -1) {
        styles[key] = value.length > 150 ? value.slice(0, 150) + "\u2026" : value;
      }
    }

    return styles;
  }

  /**
   * Get parent element context (debug mode only)
   */
  function getParentContext(el) {
    var parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) {
      return null;
    }

    // Skip picker UI elements
    while (parent && isPickerElement(parent)) {
      parent = parent.parentElement;
    }
    if (!parent || parent === document.body || parent === document.documentElement) {
      return null;
    }

    var computed = window.getComputedStyle(parent);
    var styles = {};

    styles.display = computed.display;
    styles.position = computed.position;

    if (computed.display.indexOf("flex") >= 0) {
      styles.flexDirection = computed.flexDirection;
      styles.flexWrap = computed.flexWrap;
      styles.justifyContent = computed.justifyContent;
      styles.alignItems = computed.alignItems;
      if (computed.gap && computed.gap !== "normal") {
        styles.gap = computed.gap;
      }
    }

    if (computed.display.indexOf("grid") >= 0) {
      styles.gridTemplateColumns = computed.gridTemplateColumns;
      styles.gridTemplateRows = computed.gridTemplateRows;
      if (computed.gap && computed.gap !== "normal") {
        styles.gap = computed.gap;
      }
    }

    if (computed.overflow !== "visible") {
      styles.overflow = computed.overflow;
    }

    return {
      tag: parent.tagName.toLowerCase(),
      id: parent.id || undefined,
      classes: Array.from(parent.classList),
      styles: styles
    };
  }

  /**
   * Discover all CSS variable names from stylesheets
   */
  function discoverCSSVariables() {
    if (cachedCSSVarNames) return cachedCSSVarNames;

    var varNames = new Set();

    function extractFromRules(rules) {
      if (!rules) return;
      for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        if (rule.style) {
          for (var pi = 0; pi < rule.style.length; pi++) {
            var prop = rule.style[pi];
            if (prop.startsWith("--")) {
              varNames.add(prop);
            }
          }
        }
        if (rule.cssRules) {
          extractFromRules(rule.cssRules);
        }
      }
    }

    for (var shi = 0; shi < document.styleSheets.length; shi++) {
      try {
        extractFromRules(document.styleSheets[shi].cssRules);
      } catch (e) {
        // CORS blocks access - skip this sheet
      }
    }

    cachedCSSVarNames = varNames;
    return varNames;
  }

  /**
   * Get CSS variables used by element (debug mode only)
   */
  function getCSSVariables(el) {
    var style = window.getComputedStyle(el);
    var varNames = discoverCSSVariables();
    var variables = {};

    var count = 0;
    varNames.forEach(function (name) {
      if (count >= 50) return;
      var value = style.getPropertyValue(name).trim();
      if (value) {
        variables[name] = value.length > 100 ? value.slice(0, 100) + "\u2026" : value;
        count++;
      }
    });

    return variables;
  }

  /**
   * Reset CSS variable cache (call on deactivate)
   */
  function resetCSSVarCache() {
    cachedCSSVarNames = null;
  }

  function pruneStaleSelections() {
    if (!selectedElements.length) return;

    var nextSelections = [];
    var nextScreenshots = new Map();
    var nextComments = new Map();
    var nextPositions = new Map();
    var nextOpenNotes = new Set();

    selectedElements.forEach(function (sel, i) {
      if (sel && sel.element && document.contains(sel.element)) {
        var nextIndex = nextSelections.length;
        nextSelections.push(sel);

        if (elementScreenshots.has(i)) {
          nextScreenshots.set(nextIndex, elementScreenshots.get(i));
        }
        if (elementComments.has(i)) {
          nextComments.set(nextIndex, elementComments.get(i));
        }
        if (notePositions.has(i)) {
          nextPositions.set(nextIndex, notePositions.get(i));
        }
        if (openNotes.has(i)) {
          nextOpenNotes.add(nextIndex);
        }
      } else if (openNotes.has(i)) {
        var card = notesContainer ? notesContainer.querySelector('[data-index="' + i + '"]') : null;
        if (card) card.remove();
      }
    });

    if (nextSelections.length !== selectedElements.length) {
      selectedElements = nextSelections;
      elementScreenshots = nextScreenshots;
      elementComments = nextComments;
      notePositions = nextPositions;

      notesContainer.innerHTML = "";
      openNotes = new Set();
      nextOpenNotes.forEach(function (i) { createNoteCard(i); });

      updateBadges();
      updateConnectors();
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Submit / Cancel
  // ─────────────────────────────────────────────────────────────────────

  function handleSubmit() {
    var contextEl = document.getElementById("fleet-annotate-context");
    var context = contextEl ? (contextEl.value || "").trim() : "";

    // Re-capture debug data for all elements if debug mode is on at submit time
    pruneStaleSelections();
    if (debugMode) {
      selectedElements.forEach(function (sel) {
        if (sel.element && document.contains(sel.element)) {
          sel.computedStyles = getComputedStyles(sel.element);
          sel.parentContext = getParentContext(sel.element);
          sel.cssVariables = getCSSVariables(sel.element);
        }
      });
    }

    var elements = selectedElements.map(function (sel, i) {
      return {
        selector: sel.selector,
        tag: sel.tag,
        id: sel.id,
        classes: sel.classes,
        text: sel.text,
        rect: { x: sel.rect.x, y: sel.rect.y, width: sel.rect.width, height: sel.rect.height },
        attributes: sel.attributes,
        comment: elementComments.get(i) || undefined,
        boxModel: sel.boxModel,
        accessibility: sel.accessibility,
        keyStyles: sel.keyStyles,
        computedStyles: sel.computedStyles,
        parentContext: sel.parentContext,
        cssVariables: sel.cssVariables,
        captureScreenshot: elementScreenshots.get(i) !== false,
        hasSnapshot: elementSnapshots.has(i)
      };
    });

    var result = {
      success: true,
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      context: context,
      elements: elements
    };

    deactivate();

    // Submit via preload-exposed API
    window.fleetAnnotate.submit(result);
  }

  function handleCancel() {
    deactivate();

    try {
      window.fleetAnnotate.cancel("user");
    } catch (e) {
      console.log("[fleet-annotate] Could not send cancel");
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Immediate activation
  // ─────────────────────────────────────────────────────────────────────

  console.log("[fleet-annotate] Picker loaded");
  activate();
})()`;
/* eslint-enable no-useless-escape */
