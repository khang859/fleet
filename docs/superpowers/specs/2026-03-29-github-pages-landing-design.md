# Fleet GitHub Pages Landing Page Design

## Overview

Create a GitHub Pages landing page for Fleet with 5 distinct HTML design variants for review. Each variant uses the same content sections but leads with a different hero angle and visual approach.

**Tone:** Playful, space-themed, leaning into Fleet's pixel-art mascots and sci-fi aesthetic.

**Primary CTA:** Download (macOS/Windows installers)
**Secondary CTA:** View on GitHub

## Shared Design System

- **Background:** Dark navy (`#0a0a1a`) with animated CSS star field
- **Primary accent:** Cyan (`#00FFFF`)
- **Secondary accent:** Teal (`#00D4AA`)
- **Status colors:** Amber (`#F59E0B`), Green (`#22C55E`), Blue (`#3B82F6`), Red (`#EF4444`), Gray (`#6B7280`)
- **Typography:** Monospace for headings (JetBrains Mono), sans-serif for body (Inter)
- **Format:** Self-contained single HTML files, inline CSS, Google Fonts only external dependency
- **Responsive:** Mobile-friendly with breakpoints at 768px and 1024px

## Sections (all 5 variants)

1. **Hero** — Tagline, subtitle, Download + GitHub buttons
2. **Feature Highlights** — 6 features: tabs/workspaces, split panes, activity badges, git integration, command palette, clipboard history
3. **Agent Visualizer Showcase** — The space-themed ship visualization
4. **Mascot Showcase** — The 5 copilot mascots (officer, robot, cat, bear, kraken)
5. **Screenshots/Product Tour** — App in action
6. **Footer** — GitHub, releases, changelog links

## The 5 Variants

### Variant 1: "Command Center"
- **Hero angle:** Agent Visualizer front and center
- **Tagline:** "Your AI agents, one fleet"
- **Layout:** Full-width dark canvas hero showing stylized space scene with ships. Features presented as HUD/radar-style grid cards. Visualizer section has the largest showcase. Mascots shown as "crew roster."
- **Vibe:** Military command center, sci-fi HUD

### Variant 2: "Meet the Crew"
- **Hero angle:** Mascots/personality
- **Tagline:** "Terminal multiplexing, but make it fun"
- **Layout:** Hero shows all 5 mascots lined up with playful animation (CSS bounce). Each feature section is introduced by a different mascot character. Mascot showcase is a card-flip gallery. Visualizer shown as "where the crew works."
- **Vibe:** Playful, character-driven, game-like

### Variant 3: "Terminal Evolved"
- **Hero angle:** Core product (split panes, tabs)
- **Tagline:** "Built for developers running AI agents"
- **Layout:** Hero has a large app screenshot placeholder with glowing border. Clean 3-column feature grid below. Visualizer and mascots as secondary sections. Most conventional product page structure.
- **Vibe:** Clean developer tool, with space-themed accents

### Variant 4: "Mission Briefing"
- **Hero angle:** Narrative/cinematic scroll
- **Tagline:** "Launch your fleet"
- **Layout:** Hero is a cinematic star field with a single ship approaching. Content scrolls as "mission objectives" — each section is a briefing card. Features = ship capabilities, mascots = crew members, visualizer = mission control. Progress indicator on the side.
- **Vibe:** Cinematic, storytelling, immersive scroll

### Variant 5: "Signal Dashboard"
- **Hero angle:** Activity detection / real-time monitoring
- **Tagline:** "See everything. Miss nothing."
- **Layout:** Hero shows the 4 activity badge colors (amber, green, blue, red) as large pulsing dots with labels. Features presented as status cards with colored left borders. Visualizer shown as "fleet status." Mascots as "your copilot crew."
- **Vibe:** Dashboard/control panel, data-forward

## Image Placeholders (12 total)

Each placeholder is a styled div with label, dimensions, and a dashed border.

| # | Subject | Dimensions | Generation Prompt |
|---|---------|-----------|-------------------|
| 1 | App screenshot — split panes | 1200x750 | "Screenshot of a dark-themed terminal multiplexer app with 3 split panes showing different Claude Code sessions, vertical tab sidebar on left with colored activity badges, dark navy UI with cyan accents" |
| 2 | Agent Visualizer | 1200x600 | "Pixel art space scene on dark navy background, 5 small spaceships in formation with glowing colored trails (green, blue, amber, cyan, white), stars in background, retro game aesthetic, top-down view" |
| 3 | Copilot overlay | 800x500 | "Screenshot of a floating translucent overlay panel on a dark terminal app, showing a pixel art mascot character with speech bubble, amber pulsing notification, dark navy with cyan accents" |
| 4 | Officer mascot | 128x128 | "Pixel art naval officer character, teal uniform with gold epaulettes, standing at attention, transparent background, 128x128, retro game sprite style" |
| 5 | Robot mascot | 128x128 | "Pixel art friendly robot character, silver and cyan body, glowing blue eyes, waving, transparent background, 128x128, retro game sprite style" |
| 6 | Cat mascot | 128x128 | "Pixel art space cat character, wearing a small astronaut helmet, curious pose, teal accents, transparent background, 128x128, retro game sprite style" |
| 7 | Bear mascot | 128x128 | "Pixel art armored polar bear warrior character, silver armor with teal trim, standing heroically, transparent background, 128x128, retro game sprite style" |
| 8 | Kraken mascot | 128x128 | "Pixel art astral space kraken character, cosmic purple and teal tentacles, glowing eyes, floating in space, transparent background, 128x128, retro game sprite style" |
| 9 | Activity badges | 600x200 | "4 glowing circular notification badges in a row on dark navy background: amber pulsing, green solid, blue solid, red solid, with subtle glow effects, minimal clean design" |
| 10 | Git integration | 800x500 | "Screenshot of a dark-themed file diff viewer with syntax highlighting, showing green added lines and red removed lines, branch label 'feature/auth' in top bar, dark navy UI" |
| 11 | Command palette | 800x400 | "Screenshot of a dark-themed command palette overlay (like VS Code), search bar at top with 'Open file...' placeholder, list of commands below with keyboard shortcuts, dark navy with cyan highlight on selected item" |
| 12 | Hero ship (for variant 4) | 1200x400 | "Pixel art spaceship approaching from distance in deep space, single cyan-glowing vessel against star field, cinematic wide aspect ratio, dark navy background, retro game aesthetic with modern lighting" |

## Technical Notes

- All files go in a `docs/landing/` directory
- Named: `variant-1-command-center.html` through `variant-5-signal-dashboard.html`
- Can be previewed by opening directly in a browser
- GitHub Pages deployment will use whichever variant is chosen (renamed to `index.html`)
