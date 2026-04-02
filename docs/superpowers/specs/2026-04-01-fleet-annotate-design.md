# Fleet Annotate — Visual Annotation for AI Agents

**Date:** 2026-04-01
**Status:** Approved

## Summary

Built-in visual annotation tool for Fleet. Users load a URL in an Electron BrowserWindow, click elements, add comments, and submit. Fleet writes structured results (JSON + screenshot PNGs) to a temp file. Agents read the file to get CSS selectors, box model, accessibility info, styles, comments, and screenshot paths.

Triggerable both from Fleet's UI (button) and programmatically via `fleet annotate [url]` CLI.

## Architecture

```
fleet annotate [url]          User clicks "Annotate" button
        │                              │
        ▼                              ▼
  Fleet CLI ──IPC──▶  Fleet Main Process
                            │
                            ▼
                     BrowserWindow (persistent session)
                       ├── preload.js (picker injection)
                       └── annotation UI (vanilla JS)
                            │
                            ▼
                     User picks elements, adds comments
                            │
                            ▼
                     Main process captures screenshots,
                     collects element data via executeJavaScript()
                            │
                            ▼
                     Writes result to temp file (JSON + screenshot PNGs)
                            │
                            ▼
                     Returns file path to CLI / shows path in Fleet UI
```

### Key Pieces

1. **Fleet CLI** (`fleet annotate`) — sends IPC message to running Fleet instance, waits for result file path, prints it to stdout.
2. **Main process** — opens BrowserWindow, manages annotation lifecycle, captures screenshots via `webContents.capturePage()`, writes results.
3. **BrowserWindow** — persistent Electron session (cookies/auth survive across sessions), loads target URL, runs picker/annotation UI via preload script.
4. **Result file** — JSON with full element data + separate PNG files for screenshots. Path printed to stdout so agents can read it.

### Why BrowserWindow (not Chrome extension)

Fleet is an Electron app with full Chromium control. Using a BrowserWindow eliminates the entire Chrome extension + native messaging + Unix socket chain that pi-annotate requires. The picker script is injected directly via preload, screenshots captured via `webContents.capturePage()`, and data returned via Electron IPC.

### Data Flow: Preload ↔ Main Process

The preload script exposes a `fleetAnnotate` API to the renderer via `contextBridge`. The picker UI (injected via preload) calls `fleetAnnotate.submit(data)` when the user submits. The preload forwards this over `ipcRenderer.invoke('annotate:submit', data)` to the main process. Screenshots are captured by the main process (not the renderer) via `webContents.capturePage()` — the renderer sends element rects, and the main process crops.

### Auth / Session Persistence

The annotation BrowserWindow uses a persistent Electron session (`Session.fromPartition('persist:annotate')`). Cookies and localStorage survive across annotation sessions — user logs in once, stays logged in.

## Element Picker UI

Injected into the BrowserWindow via preload script. Vanilla JS, no framework dependencies.

### Interaction Model

| Action | How |
|--------|-----|
| Select element | Click on page |
| Cycle ancestors | Alt/⌥+scroll while hovering |
| Multi-select | Toggle "Multi" or Shift+click |
| Add comment | Type in note card textarea |
| Toggle screenshot | 📷 button in note card header |
| Reposition note | Drag by header |
| Scroll to element | Click selector in note card |
| Toggle note | Click numbered badge |
| Expand/collapse all | ▼/▲ buttons in toolbar |
| Toggle annotation UI | Cmd/Ctrl+Shift+P |
| Close | Esc |

### UI Components

- **Highlight overlay** — colored border around hovered/selected elements
- **Note cards** — draggable floating cards with per-element comment textarea, screenshot toggle, SVG connector line to element
- **Toolbar** — expand/collapse all, multi-select toggle, debug mode toggle, context textarea (overall description), submit/cancel buttons
- **Numbered badges** — on selected elements, click to toggle note

### Data Captured Per Element

- CSS selector (unique)
- Tag name, ID, classes, text content
- Bounding rect (x, y, width, height)
- Box model (content, padding, border, margin)
- HTML attributes
- Key CSS styles (display, position, overflow, colors, typography)
- Accessibility info (role, name, focusable, disabled, ARIA states)
- Per-element comment
- **Debug mode extras:** computed styles (40+ properties), parent context, CSS variables

## CLI Integration

### Usage

```
fleet annotate [url]           # open URL in annotation browser
fleet annotate                 # open annotation browser with blank/last page
fleet annotate --timeout 600   # custom timeout (default 300s)
```

Prints the result file path to stdout on completion:
```
/tmp/fleet-annotate-1712000000.json
```

Agent reads the file to get structured data + screenshot paths.

### IPC Flow

1. CLI sends `{ type: "annotate:start", url?, timeout? }` to Fleet main process
2. Main process opens/reuses annotation BrowserWindow, navigates to URL
3. User annotates, clicks Submit
4. Main process collects data, captures screenshots, writes temp files
5. Main process responds `{ type: "annotate:complete", resultPath }`
6. CLI prints path to stdout and exits

### Cancellation

- User presses Esc or timeout fires → CLI gets `{ type: "annotate:cancelled", reason }` and exits with non-zero code.

### UI Trigger

A button in Fleet's toolbar (or menu) does the same thing but shows the result path in a toast/notification or copies it to clipboard.

## Screenshots

- **Per-element crops:** `webContents.capturePage()` captures the visible viewport, cropped to element's bounding rect + 20px padding.
- **Below-the-fold elements:** scroll into view, capture, scroll back.
- **Full-page mode:** screenshot with numbered badges drawn on it to identify elements.
- **Max size:** 15MB per image.
- **Format:** PNG.

## Result File Format

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1440, "height": 900 },
  "context": "Fix the button styling",
  "elements": [
    {
      "selector": "#submit-btn",
      "tag": "button",
      "id": "submit-btn",
      "classes": ["btn", "btn-primary"],
      "text": "Submit",
      "rect": { "x": 100, "y": 200, "width": 120, "height": 40 },
      "boxModel": {
        "content": { "width": 96, "height": 24 },
        "padding": { "top": 8, "right": 16, "bottom": 8, "left": 16 },
        "border": { "top": 1, "right": 1, "bottom": 1, "left": 1 },
        "margin": { "top": 0, "right": 8, "bottom": 0, "left": 8 }
      },
      "attributes": { "type": "submit", "data-testid": "submit" },
      "accessibility": {
        "role": "button",
        "name": "Submit",
        "focusable": true,
        "disabled": false
      },
      "keyStyles": {
        "display": "flex",
        "backgroundColor": "rgb(59, 130, 246)"
      },
      "comment": "Make this rounded",
      "screenshotPath": "/tmp/fleet-annotate-1712000000-el1.png"
    }
  ],
  "screenshotPath": "/tmp/fleet-annotate-1712000000-full.png"
}
```

Debug mode adds `computedStyles`, `parentContext`, and `cssVariables` fields per element.

## Error Handling

- **Session replacement:** If annotation BrowserWindow is already open and a new `fleet annotate` comes in, cancel the current session and start the new one.
- **Navigation errors:** DNS failure, timeout — report to CLI, close the window.
- **Restricted content:** `about:blank` is fine as starting state. URL load failures return error to CLI.
- **Timeouts:** Default 300s, configurable via `--timeout`. CLI exits with non-zero code + reason.
- **File cleanup:** Result files go to `os.tmpdir()` with 0600 permissions. OS temp cleanup handles removal.

## Testing Strategy

### Unit Tests

- Result file generation — given element data, produces correct JSON structure
- CLI argument parsing (`fleet annotate`, `fleet annotate <url>`, `--timeout`)
- Element data extraction logic (selector generation, box model parsing, accessibility info)

### Integration Tests

- BrowserWindow opens, loads a local test HTML page, picker injects correctly
- IPC round-trip: CLI sends annotate request → main process responds with result path
- Screenshot capture produces valid PNGs with correct dimensions
- Persistent session retains cookies between annotation sessions

### Manual Testing

- Pick single element, verify all data fields populated
- Multi-select, verify all elements captured
- Drag note cards, verify repositioning
- Alt+scroll ancestor cycling
- Debug mode toggle
- Submit/cancel flows
- Timeout behavior
- Agent workflow: run `fleet annotate` from terminal in Fleet, verify file path returned, verify agent can read the JSON

## Reference

- [pi-annotate](https://github.com/nicobailon/pi-annotate) — reference implementation (local copy at `reference/pi-annotate/`)
