# Fleet Terminal Commands

You are running inside **Fleet**, a terminal multiplexer desktop app. You can control Fleet from the command line using the `fleet` CLI.

## fleet open

Open files or images in Fleet tabs.

```bash
fleet open <path> [path2 ...]
```

- Supports relative and absolute paths
- Images (png, jpg, jpeg, gif, webp, svg, bmp, ico) open in an image viewer tab
- Code/text files open in a code viewer tab
- Directories are not supported — use file paths

### Examples

```bash
fleet open src/main.ts
fleet open screenshot.png diagram.svg
fleet open ./README.md ../other-repo/notes.txt
```

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
```

To provide multiple reference images, repeat the `--images` flag for each file:

```bash
fleet images edit --prompt "Combine these into one scene" --images img1.png --images img2.png
fleet images edit --prompt "Apply the style of the first to the second" --images style-ref.png --images target.png
fleet images edit --prompt "Merge all elements" --images bg.png --images subject.png --images overlay.png
```

Options (same as `generate`): `--provider`, `--model`, `--resolution`, `--aspect-ratio`, `--format`, `--num-images`

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
fleet images config --default-model <id>     # Set default model
fleet images config --default-resolution <res>    # Set default resolution
fleet images config --default-output-format <fmt> # Set default output format
fleet images config --default-aspect-ratio <ratio> # Set default aspect ratio
fleet images config --provider <id>          # Specify provider to configure
```

### Run image actions

```bash
fleet images action <action-type> <source>   # e.g. remove-background
fleet images actions                          # List available actions
fleet images actions --provider <id>          # List actions for a specific provider
```

## Image Prompt Best Practices

Writing effective prompts dramatically improves image generation results. Follow these guidelines when using `fleet images generate` or `fleet images edit`.

### Prompt Structure

Use this order: **Subject → Style → Setting → Lighting → Composition → Quality modifiers**

Front-load the most important elements — models weight tokens near the beginning more heavily. Aim for 30-75 words. Too short gives too much freedom; too long causes concept blending.

```bash
# Good: specific, structured
fleet images generate --prompt "A weathered lighthouse on a rocky coastline, oil painting style, dramatic sunset lighting, wide angle shot, muted tones"

# Bad: vague
fleet images generate --prompt "a cool lighthouse"
```

### Subject Description

Be specific about materials, textures, condition, and scale:

- **People:** age, expression, pose, clothing. "A middle-aged woman with silver hair, wearing a navy coat, looking contemplative"
- **Objects:** material, texture, condition. "A weathered copper compass with a cracked glass face"
- **Scenes:** describe foreground, midground, and background separately for complex compositions

### Style Keywords

| Category | Keywords |
|----------|----------|
| Traditional | oil painting, watercolor, charcoal sketch, ink wash, gouache |
| Digital | digital illustration, concept art, matte painting, 3D render, vector art |
| Photography | photorealistic, DSLR photo, film photography, 35mm film, Kodak Portra 400 |
| Specific styles | art nouveau, minimalist, cyberpunk, vaporwave, brutalist |

### Lighting

Lighting is one of the highest-impact prompt elements:

- **Natural:** golden hour, blue hour, overcast diffused light, dappled light through trees
- **Studio:** Rembrandt lighting, rim lighting, backlit silhouette, soft box lighting
- **Dramatic:** chiaroscuro, volumetric light rays, neon glow, bioluminescence, candlelight
- **Technical:** high-key (bright, minimal shadows), low-key (dark, dramatic shadows)

### Composition and Camera

- **Angles:** bird's eye view, worm's eye view, Dutch angle, eye level
- **Distance:** extreme close-up, close-up, medium shot, full body, wide shot, aerial view
- **Lens effects:** shallow depth of field, bokeh, tilt-shift, macro lens, 85mm portrait

### Common Mistakes

1. **Contradictory styles.** "A photorealistic watercolor" confuses the model — pick one
2. **Too many subjects.** Keep to 1-2 focal subjects; more creates chaotic results
3. **Wrong aspect ratio.** Use `--aspect-ratio 9:16` for portraits, `16:9` for landscapes
4. **Over-stacking quality terms.** One or two quality modifiers is enough; spend tokens on description instead
5. **Describing what you DON'T want.** "A dog but not a poodle" often generates a poodle — describe what you DO want
6. **Expecting perfect text.** Keep text in images to 1-3 short words maximum

### Consistent Series

To maintain visual consistency across multiple generations:

- Create a **style block** — a reusable suffix for all prompts: `cinematic lighting, muted earth tones, film grain, 35mm lens`
- Fix `--aspect-ratio` across the series
- Use the same character descriptions verbatim in every prompt
- Reference a specific art style or movement consistently

### Image Editing Prompts

When using `fleet images edit`:

- **Be explicit about what to change and what to keep.** "Change the sky to a sunset while keeping the building exactly the same"
- **Describe changes in relative terms.** "Make the lighting warmer" or "Add more contrast"
- **For additions:** describe only the new element. "Add a red sports car in the parking spot"
- **For style transfer:** describe the target look. "Apply a cool blue-teal color grade"

```bash
fleet images edit --prompt "Remove the background and replace with a soft gradient, keep the subject sharp" --images ./photo.png
fleet images edit --prompt "Make it look like a vintage film photograph, warm tones, slight grain" --images ./modern.png
```

### Logos, Icons, and UI Assets

For developer workflows generating visual assets:

- **Logos:** specify simplicity explicitly. "Simple, clean, minimal flat logo, monochrome, clean lines, no text, geometric shape, suitable for dark and light backgrounds"
- **Icons:** specify the system. "Material Design style icon, 2px stroke weight, rounded corners, filled style"
- **App icons:** "Squircle shape, single focal element, simple gradient background"
- **Backgrounds:** "Subtle gradient mesh, soft purple to blue, abstract, suitable for dark UI text overlay"
- **Hero images:** leave space for text. "Abstract tech background with clear space in center-left for text overlay"

AI-generated logos and icons typically need post-processing (vectorization, background removal, cleanup).

### Quick Reference Template

```
[Subject with specific details],
[Action or pose],
[Setting/environment],
[Style/medium],
[Lighting description],
[Camera/composition],
[Color palette or mood],
[1-2 quality modifiers]
```

## Tips

- Add `--format json` to any command for structured JSON output (works with `fleet open` too)
- Add `--quiet` to suppress output
- Add `--help` to any command for detailed usage info
- Image generation is asynchronous — use `fleet images status <id>` to poll for completion
- The `fleet` CLI communicates with the running Fleet app via a Unix socket. Fleet must be running for commands to work.
