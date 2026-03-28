# Fleet Terminal Commands

You are running inside **Fleet**, a terminal multiplexer desktop app. You can control Fleet from the command line using the `fleet` CLI.

## fleet open

Open files or images in Fleet tabs.

```bash
fleet open <path> [path2 ...]
```

- Supports relative and absolute paths
- Images (png, jpg, gif, webp, svg) open in an image viewer tab
- Code/text files open in a code viewer tab
- Directories are not supported — use file paths

### Examples

```bash
fleet open src/main.ts
fleet open screenshot.png diagram.svg
fleet open ./README.md ../other-repo/notes.txt
```

## fleet images

Generate, edit, and manage AI images.

### Generate an image

```bash
fleet images generate --prompt "A cat in space"
```

Options:
- `--provider <id>` — image provider (default: fal-ai)
- `--model <model>` — model to use (default: fal-ai/nano-banana-2)
- `--resolution <res>` — 0.5K, 1K, 2K, or 4K (default: 1K)
- `--aspect-ratio <ratio>` — e.g. 1:1, 16:9, 9:16 (default: 1:1)
- `--format <fmt>` — png, jpeg, or webp (default: png)
- `--num-images <n>` — 1-4 (default: 1)

### Edit an image

```bash
fleet images edit --prompt "Add a hat" --images ./cat.png
fleet images edit --prompt "Combine these" --images img1.png --images img2.png
```

### Check generation status

```bash
fleet images status <generation-id>
```

### List all generations

```bash
fleet images list
```

### Retry a failed generation

```bash
fleet images retry <generation-id>
```

### Configure image settings

```bash
fleet images config                          # Show current config
fleet images config --api-key <key>          # Set API key
fleet images config --action <type> --model <id>  # Set model for an action
```

### Run image actions

```bash
fleet images action <action-type> <source>   # e.g. remove-background
fleet images actions                          # List available actions
```

## Tips

- Add `--format json` to any command for structured JSON output
- Add `--help` to any command for detailed usage info
- Image generation is asynchronous — use `fleet images status <id>` to poll for completion
- The `fleet` CLI communicates with the running Fleet app via a Unix socket. Fleet must be running for commands to work.
