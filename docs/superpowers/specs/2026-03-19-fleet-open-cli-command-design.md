# Design: `fleet open` CLI Command

Open files or images inside the running Fleet app from the command line.

## Usage

```bash
fleet open <path1> [path2 ...]
```

Opens each file in a new tab in the Fleet app. If a file is already open, focuses the existing tab instead.

## Examples

```bash
fleet open README.md
fleet open src/main.ts src/app.tsx
fleet open screenshot.png
fleet open notes.md diagram.png config.json
```

## CLI Layer

`fleet open` is a top-level command. In `runCLI()`, when `argv[0] === 'open'`, a separate code path is taken before the standard `group.action` parsing. All remaining args (`argv.slice(1)`) are treated as file paths — `parseArgs()` is bypassed entirely and the `files` array is constructed directly.

### Validation

For each path argument, the CLI:

1. Resolves to an absolute path (relative to `process.cwd()`)
2. Checks it is not a directory (`fs.statSync().isDirectory()`)
3. Checks the file exists (`fs.existsSync`)
4. Checks the extension is not in the binary blocklist
5. Determines the pane type based on extension
6. Skips invalid files with an error message, continues with valid ones

### Pane Type Detection

**Image extensions** (open as `image` pane): `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`

**Everything else** (open as `file` pane): all other extensions and files without extensions are opened as text files.

### Binary Blocklist

The following extensions are rejected as unsupported binary files: `.zip`, `.tar`, `.gz`, `.7z`, `.rar`, `.exe`, `.dmg`, `.pkg`, `.deb`, `.rpm`, `.iso`, `.bin`, `.dll`, `.so`, `.dylib`, `.o`, `.a`, `.wasm`, `.class`, `.jar`, `.war`, `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.mp3`, `.mp4`, `.mov`, `.avi`, `.mkv`, `.flac`, `.wav`, `.aac`.

### Error Handling

- File does not exist: CLI prints error, skips file
- Binary blocklist match: CLI prints error ("unsupported binary file"), skips file
- Directory path: CLI prints error ("directories not supported, use a file path")
- No valid files after validation: CLI exits with error code
- Fleet app not running (socket connection fails): CLI prints "Fleet is not running"

## Socket Command

**Command:** `file.open`

**Payload:**

```typescript
{
  command: 'file.open',
  args: {
    files: Array<{
      path: string      // absolute path
      paneType: 'file' | 'image'
    }>
  }
}
```

**Response:**

```typescript
{ ok: true, data: { fileCount: number } }
```

The response is a simple acknowledgment with the number of files sent to the renderer. Since `webContents.send()` is fire-and-forget, the main process cannot know how many were opened vs. focused — that logic is handled entirely in the renderer.

## Socket Server (Main Process)

`SocketServer.dispatch()` receives the `file.open` command and sends an IPC message to the renderer:

**IPC Channel:** `file:open-in-tab`

**IPC Payload:**

```typescript
{
  files: Array<{
    path: string;
    paneType: 'file' | 'image';
    label: string; // basename of the file, e.g., "file.md"
  }>;
}
```

The main process sends the IPC event via `BrowserWindow.webContents.send()` and returns a success response to the CLI.

## Preload API

Add an `onOpenInTab` listener to the existing `file` namespace in `preload/index.ts`, following the existing `on*` listener pattern:

```typescript
file: {
  // ... existing methods ...
  onOpenInTab: (callback: (payload: { files: Array<{ path: string; paneType: 'file' | 'image'; label: string }> }) => void) => () => void
}
```

Returns an unsubscribe function, consistent with other listeners like `onCreateTab` and `onNotification`.

## Renderer

When the renderer receives the `file:open-in-tab` event via the preload listener:

1. For each file in the payload:
   - Check existing tabs for a pane with a matching `filePath` (absolute path comparison)
   - If found: set that tab as active (focus it)
   - If not found: create a new `Tab` with a single `PaneLeaf`:
     - `paneType`: `'file'` or `'image'`
     - `filePath`: absolute path
     - `label`: filename (basename)
   - Set the new/found tab as active
2. If multiple files are opened, the last one ends up as the active tab

The dedup logic is implemented as a new dedicated handler for the IPC event, separate from the existing `openFile()` method (which is used by the Cmd+O file dialog and always creates a new tab).

No new UI components are needed. `PaneGrid` already routes to `FileEditorPane` or `ImageViewerPane` based on `paneType`.

## Files to Modify

1. **`src/main/fleet-cli.ts`** — Add `open` branch in `runCLI()` before group.action parsing. When `argv[0] === 'open'`, bypass `parseArgs()`, validate paths, determine pane types, send `file.open` socket command with the `files` array directly.
2. **`src/main/socket-server.ts`** — Add `case 'file.open':` in `dispatch()`. Send IPC to renderer via `BrowserWindow.webContents.send()`.
3. **`src/shared/constants.ts`** — Add `FILE_OPEN_IN_TAB: 'file:open-in-tab'` to `IPC_CHANNELS`.
4. **`src/preload/index.ts`** — Add `onOpenInTab` listener in the `file` namespace, returning an unsubscribe function.
5. **`src/renderer/src/App.tsx`** (or wherever tab creation is handled, e.g., `workspace-store.ts`) — Add a new handler for `file:open-in-tab` IPC with dedup logic, separate from existing `openFile()`.
6. **`src/main/starbase/workspace-templates.ts`** — Add `fleet open` to the skill documentation.

## Dedup Behavior

- Focus existing tab if a file is already open (match by absolute path on `PaneLeaf.filePath`)
- Always open a new tab if the file isn't already open
- This is a separate code path from `openFile()` (Cmd+O dialog), which always creates new tabs
- Directories are rejected at the CLI level with an error message

## Future Extensions

- Directory support: open a file browser tab (not in scope now, but `paneType` is extensible)
- `--sector` flag to open files in an existing tab as split panes
- `fleet open --wait` to block until the tab is closed (useful for `$EDITOR` integration)
